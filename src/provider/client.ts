import { jsonrepair } from 'jsonrepair';
import type { Config, Message, SampledToken, Tool, ToolCall, Usage } from '../types.js';
import { debugLog } from '../debug.js';
import type { AgedStats, CapStats } from './toolcall.js';
import {
  latchShapeRejection,
  messagesToChatParams,
  resetShapeLatches,
  shapeLatchActive,
  shapeRejection,
  toolsToChatTools,
} from './toolcall.js';
import { streamChatCompletion } from './transport.js';
import type { ChatCompletionRequest, ChatMessageParam } from './transport.js';

export type ModelResponse = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  // The provider's stop reason for the last chunk. 'length' means generation was cut off
  // at the token limit (the per-turn backstop firing, or a spiral hitting it) — the loop
  // uses it to recover rather than treat a truncated turn as a real final answer.
  finishReason?: string;
  // Wall-clock split for this call (issue #195): `ttftMs` is time-to-first-token — prefill of
  // whatever the engine's prompt cache could not reuse, plus a fixed per-request overhead — and
  // `totalMs` is the whole stream. Absent when no delta ever arrived (empty or aborted stream).
  timing?: { ttftMs: number; totalMs: number };
  // Per-token logprobs for the generated content, when they were requested AND the engine
  // returned them (issue #134). Absent otherwise — an absent array means "not measured", never
  // "the model was certain". Only the debug drift instrumentation reads it.
  sampled?: SampledToken[];
};

// Session latch: once an engine rejects a request carrying the logprobs fields, stop asking. The
// degrade below retries that first request without them, so the turn survives; this keeps every
// later round from paying the same failed round-trip. Exported reset is for tests only.
let logprobsUnsupported = false;
// Same latch for `tool_choice: 'none'`. The degrade retries with the tools dropped — the shape the
// report rounds sent before the field existed — so a backend that rejects it costs one round-trip
// once and then gets the old (full re-prefill) request every time.
let toolChoiceUnsupported = false;

export function resetLogprobSupport(): void {
  logprobsUnsupported = false;
  toolChoiceUnsupported = false;
  // The shape latches (toolcall.ts) belong to the same session-latch family, so the one reset
  // client tests call clears them too.
  resetShapeLatches();
}

export async function callModel(opts: {
  system: string;
  history: Message[];
  tools: Tool[];
  config: Config;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  signal?: AbortSignal;
  // Learned char→token calibration, used to size the fit-to-window payload cap.
  calibration?: number;
  // Per-turn generation backstop computed by the caller (window − prompt − margin).
  // Falls back to the profile's fixed REIKA_MAX_TOKENS when not provided.
  maxTokens?: number;
  // One-shot per-token logit offsets for the last-resort rumination recovery (see agent/logitrecovery.ts).
  // Set only on the single biased recovery round; absent on every normal turn.
  logitBias?: Record<number, number>;
  // EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): prefix-stable serialization + a transient
  // harness note as the final user message instead of a system suffix. See provider/toolcall.ts.
  prefixStable?: boolean;
  trailingNote?: string;
  // Override the freeze-on-serialize default below. The speculative KV warm (agent/warm.ts)
  // passes false: only the turn's real call may stamp `rendered` bytes — a warm serializes the
  // same frozen bytes read-only, so a throwaway request can never mutate shared history.
  stampRenders?: boolean;
  // Debug hook: called with the exact serialized request messages before sending, so the loop's
  // prefix-divergence instrumentation measures what the engine actually receives.
  onRequest?: (messages: ChatMessageParam[]) => void;
  // Debug hook: what the fit-to-window cap did to this request's fresh tool payloads (#253).
  // Same discipline as onRequest — measurement only, never set on a normal run.
  onCapStats?: (stats: CapStats) => void;
  // Debug hook: what eviction did to this request's aged tool payloads (#260). Same discipline.
  onAgedStats?: (stats: AgedStats) => void;
  // Ask for per-token logprobs with this many top-k alternatives per position (issue #134).
  // Set only by the debug drift instrumentation; undefined leaves the request byte-identical
  // to a normal turn.
  logprobs?: number;
  // Forbid a tool call without dropping the tool list from the request (#426). A request with no
  // `tools` renders a different system turn, which is a re-prefill of the whole prompt on the one
  // round that sits right before a fold. Ignored when `tools` is empty.
  toolChoice?: 'none';
}): Promise<ModelResponse> {
  if (opts.signal?.aborted) {
    return { content: '', toolCalls: undefined };
  }
  // One closure so the shape-rejection retry below can rebuild this request with a just-latched
  // shape applied — both shapes are produced at serialization time, not editable on the body.
  // `rerender` is set only by that retry: it drops the frozen payload stamps so the rebuilt
  // request is re-rendered and re-capped against the reasoning the retry re-adds, instead of
  // reusing bytes the cap sized for a request that did not carry it (see toolcall.ts).
  const serialize = (rerender = false): ChatMessageParam[] =>
    messagesToChatParams(opts.system, opts.history, {
      contextWindow: opts.config.contextWindow,
      calibration: opts.calibration,
      reasoningRounds: opts.config.reasoningRounds,
      minGenTokens: opts.config.minGenTokens,
      prefixStable: opts.prefixStable,
      // The real call is the one that freezes live-payload bytes (estimates and warms never do).
      stampRenders: opts.stampRenders ?? opts.prefixStable,
      rerender,
      trailingNote: opts.trailingNote,
      onCapStats: opts.onCapStats,
      onAgedStats: opts.onAgedStats,
    });
  const messages = serialize();
  opts.onRequest?.(messages);
  const maxTokens = opts.maxTokens ?? opts.config.maxTokens;

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const sampled: SampledToken[] = [];
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  // Reset per consume attempt: the logprobs degrade below re-sends from scratch, so a retry's
  // prefill must not be timed from the rejected request's start.
  let startedAt = Date.now();
  let ttftMs: number | undefined;
  const timing = (): ModelResponse['timing'] =>
    ttftMs == null ? undefined : { ttftMs, totalMs: Date.now() - startedAt };

  const wantLogprobs = !!opts.logprobs && opts.logprobs > 0 && !logprobsUnsupported;
  const wantToolChoice = !!opts.toolChoice && opts.tools.length > 0 && !toolChoiceUnsupported;
  // A latched-off tool_choice means the tools go too: the caller asked for a round with no calls,
  // and without the field the only way to guarantee that is the old no-tools request.
  const sendTools = opts.tools.length > 0 && !(opts.toolChoice && toolChoiceUnsupported);
  const body: ChatCompletionRequest = {
    model: opts.config.model,
    messages,
    ...(sendTools ? { tools: toolsToChatTools(opts.tools) } : {}),
    ...(wantToolChoice ? { tool_choice: opts.toolChoice } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(opts.logitBias && Object.keys(opts.logitBias).length > 0
      ? { logit_bias: opts.logitBias }
      : {}),
    ...(wantLogprobs ? { logprobs: true, top_logprobs: opts.logprobs } : {}),
  };

  // True once a single chunk has been consumed. Gates the logprobs degrade below: retrying after
  // any content streamed would duplicate it (same rule transport.ts applies to its own retries).
  let received = false;

  const consume = async (req: ChatCompletionRequest): Promise<void> => {
    startedAt = Date.now();
    ttftMs = undefined;
    const stream = streamChatCompletion({
      baseURL: opts.config.baseURL,
      apiKey: opts.config.apiKey,
      body: req,
      signal: opts.signal,
    });

    for await (const chunk of stream) {
      received = true;
      if (chunk.usage) {
        // Cache-hit accounting is reported under different field names per provider:
        // OpenAI nests it in `prompt_tokens_details.cached_tokens`; DeepSeek exposes
        // a top-level `prompt_cache_hit_tokens`. Accept either; undefined otherwise.
        const u = chunk.usage;
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
        usage = {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          ...(cached != null ? { cachedTokens: cached } : {}),
        };
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      // Logprobs ride the choice, not the delta, and a chunk can carry them with no delta at all
      // — so collect before the delta guard. Normalized to SampledToken here (the wire's null
      // top_logprobs becomes an absent `top`) so nothing downstream handles wire shapes.
      const lp = chunk.choices?.[0]?.logprobs?.content;
      if (lp) {
        for (const t of lp) {
          sampled.push({
            token: t.token,
            logprob: t.logprob,
            ...(t.top_logprobs && t.top_logprobs.length > 0 ? { top: t.top_logprobs } : {}),
          });
        }
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      // First chunk carrying generated tokens ends prefill. Role-only openers and usage-only
      // chunks carry no work, so they must not stop the clock early.
      if (
        ttftMs == null &&
        (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)
      )
        ttftMs = Date.now() - startedAt;
      if (delta.content) {
        contentParts.push(delta.content);
        opts.onContentDelta?.(delta.content);
      }
      // Field name differs by provider: DeepSeek/Kimi use `reasoning_content`,
      // OpenRouter normalizes to `reasoning`. Accept either.
      const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
      if (reasoningChunk) {
        reasoningParts.push(reasoningChunk);
        opts.onReasoningDelta?.(reasoningChunk);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let acc = callsByIndex.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? '', name: '', args: '' };
            callsByIndex.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }
  };

  try {
    // Degrade ladder for the optional fields, outermost first. Each is the ONLY difference from a
    // plain request, so a failure before a single chunk arrived is the engine rejecting it (some
    // OpenAI-compatible shims 400 on top_logprobs, or on logprobs alongside tools). Neither may
    // cost a turn: latch the field off for the session and retry the same request without it.
    let req = body;
    for (;;) {
      try {
        await consume(req);
        break;
      } catch (e) {
        if (received || opts.signal?.aborted) throw e;
        const reason = e instanceof Error ? e.message : String(e);
        // Shape rejection, matched on the backend's own words: a pruned old `reasoning_content`
        // ("must be passed back to the API") or the `name` on tool messages (`"name"` is not
        // supported). Latch the shape, re-serialize, resend — the retried bytes, and every later
        // request this session, carry the shape the endpoint accepts. The byte compare is the
        // loop guard: once the latch is spent the rebuild matches and the error falls through,
        // instead of retrying a request that cannot change.
        const shape = shapeRejection(reason);
        if (shape) {
          // Asked before latching: the byte compare alone cannot see a spent latch once the rebuild
          // re-renders, since re-capped payloads differ from the request that was just refused.
          const alreadyLatched = shapeLatchActive(shape);
          latchShapeRejection(shape);
          // Only the reasoning shape adds bytes the frozen payloads were not capped against; the
          // name shape only shrinks the request, so re-rendering it would re-cap payloads the model
          // already saw whole and freeze the cut copies for the rest of the session.
          const rebuilt = serialize(shape === 'reasoning-roundtrip');
          if (alreadyLatched || JSON.stringify(rebuilt) === JSON.stringify(req.messages)) {
            // The shape is already applied and the endpoint still refused it — a reasoning byte
            // that is no longer in history (a fold took it), or a reworded rejection that latched
            // on its first match. Either way the rebuild cannot change, so surface it.
            debugLog(
              `[reika:debug] ${shape} rejected with that shape already latched — nothing left to change (${reason})\n`,
            );
            throw e;
          }
          debugLog(
            `[reika:debug] ${shape} rejected by backend — retrying reshaped request (${reason})\n`,
          );
          opts.onRequest?.(rebuilt);
          req = { ...req, messages: rebuilt };
          continue;
        }
        if (req.logprobs !== undefined) {
          logprobsUnsupported = true;
          debugLog(
            `[reika:debug] logprobs unsupported by backend — retrying without (${reason})\n`,
          );
          const { logprobs: _logprobs, top_logprobs: _topLogprobs, ...plain } = req;
          req = plain;
          continue;
        }
        if (req.tool_choice !== undefined) {
          toolChoiceUnsupported = true;
          debugLog(
            `[reika:debug] tool_choice unsupported by backend — retrying without tools (${reason})\n`,
          );
          const { tool_choice: _toolChoice, tools: _tools, ...plain } = req;
          req = plain;
          continue;
        }
        // Nothing left to degrade. `shapeRejection` only matches the phrasings we know, so a
        // reworded rejection lands here with no retry — this line is what makes it diagnosable
        // from a run rather than from a bug report.
        debugLog(`[reika:debug] unclassified pre-chunk failure, no degrade left (${reason})\n`);
        throw e;
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      return {
        content: contentParts.join(''),
        reasoning: reasoningParts.join('') || undefined,
        toolCalls: undefined,
        usage,
        finishReason,
        timing: timing(),
        ...(sampled.length > 0 ? { sampled } : {}),
      };
    }
    throw e;
  }

  const nativeToolCalls: ToolCall[] = [];
  for (const [, acc] of callsByIndex) {
    const name = sanitizeToolName(acc.name);
    const { args, repaired } = tryParseJson(acc.args || '{}');
    if (repaired) {
      process.stderr.write(`[reika] repaired malformed JSON in tool args for ${name}\n`);
    }
    nativeToolCalls.push({ id: acc.id, name, args });
  }

  const resolved = resolveResponseText(
    contentParts.join(''),
    reasoningParts.join(''),
    nativeToolCalls,
  );
  return {
    content: resolved.content,
    reasoning: resolved.reasoning,
    toolCalls: resolved.toolCalls.length > 0 ? resolved.toolCalls : undefined,
    usage,
    finishReason,
    timing: timing(),
    ...(sampled.length > 0 ? { sampled } : {}),
  };
}

// Resolve the final (content, reasoning, toolCalls) from a streamed response. Pure and exported so
// the recovery/stripping rules are unit-testable without mocking a stream. Two jobs:
//   1. Recover an inline tool call when the model emitted one as text instead of via native
//      function-calling — from content, or (when content is empty) from the reasoning channel.
//      The empty-content guard keeps a real final answer from being hijacked.
//   2. Strip recognized tool-call markup from the reasoning that's handed back. This is the
//      load-bearing fix: with reasoningRounds > 1 a surviving `<function=…>` block in reasoning is
//      re-read by the model next round and re-fired, an identical-read loop that mimics the model
//      spinning but is really un-stripped dialect markup (observed bricking 35B Q2). Stripping is
//      unconditional, so it also cleans markup the model narrated alongside a native call; when
//      there's no markup, cleanedContent is the reasoning unchanged and a normal turn is identical.
export function resolveResponseText(
  rawContent: string,
  rawReasoning: string,
  nativeToolCalls: ToolCall[],
): { content: string; reasoning: string | undefined; toolCalls: ToolCall[] } {
  const toolCalls = [...nativeToolCalls];
  let content = rawContent;
  const parsedReasoning = extractToolCallsFromContent(rawReasoning);

  if (toolCalls.length === 0) {
    const fallback = extractToolCallsFromContent(content);
    if (fallback.calls.length > 0) {
      toolCalls.push(...fallback.calls);
      content = fallback.cleanedContent;
    } else if (!content.trim() && parsedReasoning.calls.length > 0) {
      toolCalls.push(...parsedReasoning.calls);
    }
  }

  return { content, reasoning: parsedReasoning.cleanedContent || undefined, toolCalls };
}

// Strip chat-template artifacts that some servers (Harmony / gpt-oss, certain
// llama.cpp builds) leak into the tool name field. Exported for unit tests.
export function sanitizeToolName(raw: string): string {
  return raw.replace(/<\|[^|]*\|>.*$/, '').trim();
}

// Parse tool-call JSON args with a forgiving fallback. Small/local models
// occasionally emit slop (trailing commas, single quotes, unquoted keys, truncation).
// `repaired: true` signals jsonrepair was used — caller may want to log it so
// "this tool got weird args" is debuggable. Exported for unit tests.
export function tryParseJson(input: string): {
  args: Record<string, unknown> & { name?: unknown; arguments?: unknown; args?: unknown };
  repaired: boolean;
} {
  const wrap = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  try {
    return { args: wrap(JSON.parse(input || '{}')), repaired: false };
  } catch {
    // fall through to repair
  }
  try {
    return { args: wrap(JSON.parse(jsonrepair(input))), repaired: true };
  } catch {
    return { args: {}, repaired: false };
  }
}

// A content parser extracts tool calls embedded in assistant text, for models
// that emit calls inline instead of via native function-calling. It returns null
// when its format isn't present, so parsers can be tried in a chain. Each format
// varies on two independent axes — the *envelope* (how the call is fenced) and the
// *payload* (JSON vs pythonic kwargs) — so adding a new model's dialect is one more
// function pushed onto CONTENT_PARSERS, not a change to the dispatch site.
export type ContentToolCallParser = (
  content: string,
) => { calls: ToolCall[]; cleanedContent: string } | null;

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

// `<tool_call>{json}</tool_call>` — Qwen/Hermes-style, JSON payload.
export function parseXmlToolCalls(
  content: string,
): { calls: ToolCall[]; cleanedContent: string } | null {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    const { args: parsed, repaired } = tryParseJson(match[1]);
    if (typeof parsed.name !== 'string') continue;
    const rawArgs = parsed.arguments ?? parsed.args ?? {};
    const args =
      typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
    if (repaired) {
      process.stderr.write(`[reika] repaired malformed JSON in <tool_call> for ${parsed.name}\n`);
    }
    calls.push({
      id: `xml-${Math.random().toString(36).slice(2, 10)}`,
      name: parsed.name,
      args,
    });
  }
  if (calls.length === 0) return null;
  return { calls, cleanedContent: content.replace(TOOL_CALL_RE, '').trim() };
}

// `<function=name><parameter=key>value</parameter></function>` — Hermes/Qwen XML dialect,
// optionally wrapped in `<tool_call>…</tool_call>`. Distinct from parseXmlToolCalls (which wants
// a JSON payload): here the call name is an attribute and each arg is its own tag with a raw
// (unquoted) text body. Seen leaking from 30–35B local models when they fall back from native
// function-calling mid-turn; without this they'd be committed as junk content.
const FN_BLOCK_RE = /<function=([A-Za-z_]\w*)>([\s\S]*?)<\/function>/g;
const FN_PARAM_RE = /<parameter=([A-Za-z_]\w*)>([\s\S]*?)<\/parameter>/g;

// Coerce a raw XML parameter body to its JSON-text form: bare numbers/booleans/null pass
// through, everything else (paths, patterns) is treated as a string. Mirrors pyValueToJson.
function xmlParamToJson(v: string): string {
  const t = v.trim();
  if (/^-?\d+$/.test(t) || /^-?\d*\.\d+$/.test(t)) return t;
  if (t === 'true' || t === 'false' || t === 'null') return t;
  return JSON.stringify(t);
}

export function parseHermesXmlToolCalls(
  content: string,
): { calls: ToolCall[]; cleanedContent: string } | null {
  const calls: ToolCall[] = [];
  let block: RegExpExecArray | null;
  FN_BLOCK_RE.lastIndex = 0;
  while ((block = FN_BLOCK_RE.exec(content)) !== null) {
    const name = block[1];
    const fields: string[] = [];
    let param: RegExpExecArray | null;
    FN_PARAM_RE.lastIndex = 0;
    while ((param = FN_PARAM_RE.exec(block[2])) !== null) {
      fields.push(`${JSON.stringify(param[1])}:${xmlParamToJson(param[2])}`);
    }
    calls.push({
      id: `fn-${Math.random().toString(36).slice(2, 10)}`,
      name,
      args: tryParseJson(`{${fields.join(',')}}`).args,
    });
  }
  if (calls.length === 0) return null;
  const cleanedContent = content
    .replace(FN_BLOCK_RE, '')
    .replace(/<\/?tool_call>/g, '')
    .trim();
  return { calls, cleanedContent };
}

// Pythonic tool calls: `[fn(k=v, ...), ...]`, optionally fenced by sentinel tokens
// (`<|tool_call_start|>…<|tool_call_end|>` for Qwen-style, `<|python_tag|>…` for
// Llama 3.x). Args are Python kwargs, not JSON. We support flat kwargs only —
// each value is mapped to its JSON form and parsed via tryParseJson. Positional
// args and nested calls are unsupported (logged + skipped).
const PY_SENTINELS = [
  /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g,
  /<\|python_tag\|>([\s\S]*?)(?=<\||$)/g,
];
const PY_CALL_RE = /([A-Za-z_]\w*)\s*\(([\s\S]*?)\)/g;

export function parsePythonicToolCalls(
  content: string,
): { calls: ToolCall[]; cleanedContent: string } | null {
  // Candidate regions: sentinel-fenced bodies, or — absent sentinels — the whole
  // content when it is itself just a pythonic call list (guards against prose).
  const bodies: string[] = [];
  let hadSentinel = false;
  for (const re of PY_SENTINELS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      hadSentinel = true;
      bodies.push(m[1]);
    }
  }
  let bareMatch = false;
  if (!hadSentinel) {
    const trimmed = content.trim();
    if (/^\[?\s*[A-Za-z_]\w*\s*\(/.test(trimmed) && /\)\s*\]?$/.test(trimmed)) {
      bodies.push(trimmed);
      bareMatch = true;
    }
  }
  if (bodies.length === 0) return null;

  const calls: ToolCall[] = [];
  for (const body of bodies) {
    PY_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PY_CALL_RE.exec(body)) !== null) {
      const name = m[1];
      const args = parsePythonicArgs(m[2], name);
      if (!args) continue;
      calls.push({ id: `py-${Math.random().toString(36).slice(2, 10)}`, name, args });
    }
  }
  if (calls.length === 0) return null;

  let cleanedContent = content;
  if (bareMatch) {
    cleanedContent = '';
  } else {
    for (const re of PY_SENTINELS) cleanedContent = cleanedContent.replace(re, '');
    cleanedContent = cleanedContent.trim();
  }
  return { calls, cleanedContent };
}

// Convert flat Python kwargs (`key=value, ...`) into a parsed args object.
// Returns null if the body uses an unsupported feature (positional args).
function parsePythonicArgs(body: string, name: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (trimmed === '') return {};
  const fields: string[] = [];
  for (const part of splitTopLevel(trimmed)) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      process.stderr.write(`[reika] skipped pythonic call ${name}: positional args unsupported\n`);
      return null;
    }
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(key)) return null;
    fields.push(`${JSON.stringify(key)}:${pyValueToJson(part.slice(eq + 1).trim())}`);
  }
  return tryParseJson(`{${fields.join(',')}}`).args;
}

// Map a single Python literal to its JSON-text form. Numbers, double-quoted
// strings, lists and dicts pass through to tryParseJson (which repairs the rest).
function pyValueToJson(v: string): string {
  if (v === 'True') return 'true';
  if (v === 'False') return 'false';
  if (v === 'None') return 'null';
  const single = /^'([\s\S]*)'$/.exec(v);
  if (single) return JSON.stringify(single[1]);
  return v;
}

// Split on commas that are not inside quotes, parens, brackets or braces.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(p => p !== '');
}

const CONTENT_PARSERS: ContentToolCallParser[] = [
  parseXmlToolCalls,
  parseHermesXmlToolCalls,
  parsePythonicToolCalls,
];

// Try each text-based tool-call format in order; first non-empty result wins.
// Native function-calling always takes precedence — this only runs as a fallback.
export function extractToolCallsFromContent(content: string): {
  calls: ToolCall[];
  cleanedContent: string;
} {
  for (const parse of CONTENT_PARSERS) {
    const result = parse(content);
    if (result && result.calls.length > 0) return result;
  }
  return { calls: [], cleanedContent: content };
}
