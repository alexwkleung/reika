import OpenAI from 'openai';
import { jsonrepair } from 'jsonrepair';
import type { Config, Message, Tool, ToolCall, Usage } from '../types.js';
import { messagesToOpenAI, toolsToOpenAI } from './toolcall.js';

export type ModelResponse = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
};

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
}): Promise<ModelResponse> {
  if (opts.signal?.aborted) {
    return { content: '', toolCalls: undefined };
  }
  const client = new OpenAI({
    baseURL: opts.config.baseURL,
    apiKey: opts.config.apiKey,
  });
  const messages = messagesToOpenAI(opts.system, opts.history, {
    contextWindow: opts.config.contextWindow,
    calibration: opts.calibration,
    reasoningRounds: opts.config.reasoningRounds,
  });

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | undefined;

  try {
    const stream = await client.chat.completions.create(
      {
        model: opts.config.model,
        messages,
        tools: opts.tools.length > 0 ? toolsToOpenAI(opts.tools) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.config.maxTokens ? { max_tokens: opts.config.maxTokens } : {}),
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      if (chunk.usage) {
        // Cache-hit accounting is reported under different field names per provider:
        // OpenAI nests it in `prompt_tokens_details.cached_tokens`; DeepSeek exposes
        // a top-level `prompt_cache_hit_tokens`. Accept either; undefined otherwise.
        const u = chunk.usage as typeof chunk.usage & {
          prompt_tokens_details?: { cached_tokens?: number | null } | null;
          prompt_cache_hit_tokens?: number | null;
        };
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
        usage = {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          ...(cached != null ? { cachedTokens: cached } : {}),
        };
      }
      const delta = chunk.choices[0]?.delta as
        | ((typeof chunk.choices)[0]['delta'] & {
            reasoning_content?: string | null;
            reasoning?: string | null;
          })
        | undefined;
      if (!delta) continue;
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
  } catch (e) {
    if (opts.signal?.aborted) {
      return {
        content: contentParts.join(''),
        reasoning: reasoningParts.join('') || undefined,
        toolCalls: undefined,
        usage,
      };
    }
    throw e;
  }

  const toolCalls: ToolCall[] = [];
  for (const [, acc] of callsByIndex) {
    const name = sanitizeToolName(acc.name);
    const { args, repaired } = tryParseJson(acc.args || '{}');
    if (repaired) {
      process.stderr.write(`[reika] repaired malformed JSON in tool args for ${name}\n`);
    }
    toolCalls.push({ id: acc.id, name, args });
  }

  let content = contentParts.join('');

  if (toolCalls.length === 0) {
    const fallback = extractToolCallsFromContent(content);
    if (fallback.calls.length > 0) {
      toolCalls.push(...fallback.calls);
      content = fallback.cleanedContent;
    }
  }

  return {
    content,
    reasoning: reasoningParts.join('') || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
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

const CONTENT_PARSERS: ContentToolCallParser[] = [parseXmlToolCalls, parsePythonicToolCalls];

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
