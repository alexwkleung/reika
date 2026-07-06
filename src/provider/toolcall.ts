import type { Message, Tool } from '../types.js';
import type { ChatMessageParam, ChatTool } from './transport.js';
import { DEFAULT_MIN_GEN_TOKENS } from './budget.js';

// Keep in sync with CHARS_PER_TOKEN in ./tokens.ts — the heuristic that maps the
// token-denominated window to the char-denominated payload length.
const CHARS_PER_TOKEN = 4;
// Use only this fraction of the computed budget, as slack against estimate error and the
// learned calibration lagging a step behind a sudden content shift.
const BUDGET_SAFETY = 0.9;
// Floor on the calibration used *for the cap* (calibration = real tokens per estimate ≈
// 4/chars-per-token). The learned average is trained on whatever the session has seen
// (often prose-heavy reasoning, ~3.5 chars/token) and badly under-counts a sudden dump of
// dense content like build logs or minified code (~2–2.5 chars/token). Since the cap is a
// safety backstop and truncation is recoverable, assume the dense worst case here so a
// single tool dump can't overflow the window while calibration is still catching up.
const CAP_DENSITY_FLOOR = 2.0;

export function messagesToOpenAI(
  system: string,
  history: Message[],
  opts?: {
    contextWindow?: number;
    calibration?: number;
    reasoningRounds?: number;
    minGenTokens?: number;
    // EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): serialize for prompt-prefix stability. Payload
    // liveness becomes sticky (`m.aged`, set only by batch aging) instead of trailing-block-only,
    // reasoning retention becomes sticky (`m.reasoningAged`) instead of last-N-rounds, and a live
    // payload's bytes are frozen via `m.rendered` — so between shrink events consecutive requests
    // are append-only and the inference engine's prompt cache stays valid. See agent/compaction.ts
    // batchAgePayloads for the aging side.
    prefixStable?: boolean;
    // Persist `m.rendered` stamps while serializing. True only on the real call path (client.ts):
    // estimates must not stamp, or WHEN a payload freezes would depend on estimate timing (which
    // varies with debug logging) instead of deterministically on the request that first sent it.
    stampRenders?: boolean;
    // Transient per-round harness note (loop ledgers / nudges) appended as the FINAL user message
    // instead of mutating the system prompt — a system-suffix change invalidates the prefix cache
    // from token 0; a tail message costs nothing. Never enters history.
    trailingNote?: string;
  },
): ChatMessageParam[] {
  const prefixStable = !!opts?.prefixStable;
  const freshFrom = prefixStable ? 0 : findFreshToolBlockStart(history);
  // Reasoning is scratch work that a thinking model emits every round; kept unbounded it
  // starves the budget over a long multi-round turn, but pruning it too hard makes the
  // model re-derive the same analysis across rounds. Keep the last N tool-call rounds (the
  // active roundtrip is always among them — required so providers that validate it don't
  // break, see the cloud-thinking-models note) and drop older reasoning.
  const reasoningRounds =
    opts?.reasoningRounds && opts.reasoningRounds > 0 ? opts.reasoningRounds : 1;
  const keepReasoningFrom = reasoningKeepFromIndex(history, reasoningRounds);
  // Compaction recaps fold into the single leading system block (rather than a second
  // system message mid-array) for the widest chat-template compatibility.
  const recaps = history.filter(m => m.role === 'compaction').map(m => m.content);
  // Will any real user turn reach the model? Meta (slash-command echo) turns are skipped below, and
  // compaction folds user turns into the recap — so a heavily-compacted long turn can end up with
  // ZERO user messages. Some chat templates hard-raise on that ("No user query found in messages",
  // observed on a 35B served by llama.cpp right after a mid-turn compaction → 400). Keep folding the
  // recap into the system block normally, but when there'd be no user turn at all, surface the recap
  // as a user message instead so the request always contains one.
  const hasUserTurn = history.some(m => m.role === 'user' && !m.meta);
  const recapText = recaps.length
    ? `# Earlier conversation (compacted)\n\n${recaps.join('\n\n')}`
    : '';
  const systemContent = recapText && hasUserTurn ? `${system}\n\n${recapText}` : system;
  // Fit-to-window: cap the fresh tool payloads to whatever room is left after everything
  // else in the request, so a single big tool round can never overflow the server.
  const perPayloadCap = freshPayloadCharCap(
    systemContent,
    history,
    freshFrom,
    keepReasoningFrom,
    opts,
  );
  const out: ChatMessageParam[] = [{ role: 'system', content: systemContent }];
  // Compaction left no user turn — surface the recap as the user message so a user-requiring
  // template still renders. (Normal case: hasUserTurn is true and the recap stayed in the system
  // block above.) Carries the original task too, since buildRecap records "- User: <task>".
  if (recapText && !hasUserTurn) {
    out.push({ role: 'user', content: recapText });
  }
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'user') {
      // Slash-command echoes (meta) belong to the UI scrollback only — the model never
      // sees a bare `/model` or `/stats` turn (its system response was already dropped).
      if (msg.meta) continue;
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const hasTools = !!msg.toolCalls && msg.toolCalls.length > 0;
      const param: Record<string, unknown> = {
        role: 'assistant',
        content: hasTools && !msg.content ? null : msg.content,
      };
      if (hasTools) {
        param.tool_calls = msg.toolCalls!.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));
      }
      if (msg.reasoning && (prefixStable ? !msg.reasoningAged : i >= keepReasoningFrom)) {
        param.reasoning_content = msg.reasoning;
      }
      out.push(param as unknown as ChatMessageParam);
    } else if (msg.role === 'tool') {
      let content: string;
      if (prefixStable) {
        if (msg.payload && !msg.aged) {
          // Frozen bytes: reuse the stamped rendering while live; stamp on the real call only.
          const rendered =
            msg.rendered ?? `${msg.summary}\n\n${capPayload(msg.payload, perPayloadCap)}`;
          if (opts?.stampRenders) msg.rendered = rendered;
          content = rendered;
        } else {
          content = msg.summary;
        }
      } else {
        const fresh = i >= freshFrom && msg.payload;
        content = fresh
          ? `${msg.summary}\n\n${capPayload(msg.payload!, perPayloadCap)}`
          : msg.summary;
      }
      const toolName = findToolNameForCall(history, msg.callId);
      const param: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: msg.callId,
        content,
      };
      if (toolName) param.name = toolName;
      out.push(param as unknown as ChatMessageParam);
    }
    // error messages are UI-only and intentionally skipped here
  }
  // The transient harness note rides at the very END: the tail is rewritten every round anyway (new
  // tool results), so a note here is free for the prefix cache — and recency-adjacent, where a small
  // model attends hardest. It also counts as the user message a user-requiring template needs.
  if (opts?.trailingNote) {
    out.push({ role: 'user', content: opts.trailingNote });
  }
  // Final backstop: if somehow still no user message (e.g. an all-meta history with no recap), inject
  // a minimal one right after the system block so a user-requiring template doesn't 400. Cheap
  // insurance; not hit in the normal flow (which always has a user turn or a recap).
  if (!out.some(m => m.role === 'user')) {
    out.splice(1, 0, { role: 'user', content: '(continue)' });
  }
  return out;
}

// Start index of the trailing block of tool messages — tool messages at or after
// this index keep their payloads; earlier ones collapse to summary. Exported for
// batch aging (agent/compaction.ts), which must never age the active round's results.
export function findFreshToolBlockStart(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'tool') return i + 1;
  }
  return 0;
}

// Per-payload character budget for the fresh tool block, computed to *fit the window*:
// take the prompt's char budget (window minus response headroom, converted from tokens
// via the learned calibration), subtract everything else in the request, and split what
// remains across the fresh payloads. Returns undefined (no cap) when the context window
// is unknown; 0 collapses payloads to summary-only when nothing else leaves room.
function freshPayloadCharCap(
  systemContent: string,
  history: Message[],
  freshFrom: number,
  keepReasoningFrom: number,
  opts?: {
    contextWindow?: number;
    calibration?: number;
    minGenTokens?: number;
    prefixStable?: boolean;
  },
): number | undefined {
  const cw = opts?.contextWindow;
  if (!cw) return undefined;
  const prefixStable = !!opts?.prefixStable;
  // Reserve the same generation room the backstop and compaction use, so a fresh tool
  // dump can't leave a thinking model with no tokens to respond in. See provider/budget.ts.
  const reserve =
    opts?.minGenTokens && opts.minGenTokens > 0 ? opts.minGenTokens : DEFAULT_MIN_GEN_TOKENS;
  const learned = opts?.calibration && opts.calibration > 0 ? opts.calibration : 1;
  // The floor is only for converting the *fresh* allowance to chars — the non-fresh content
  // is already-seen and well-described by the learned average, so applying the worst-case
  // density to the whole budget (as a naive cap would) needlessly shrinks the effective
  // window and truncates tool output even when there's plenty of real room.
  const capCalib = Math.max(learned, CAP_DENSITY_FLOOR);

  let freshCount = 0;
  let nonFreshChars = systemContent.length;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (prefixStable && m.role === 'tool' && m.payload && !m.aged) {
      if (m.rendered !== undefined) {
        // Already-frozen bytes are a fixed cost, not a share of the fresh budget — only payloads
        // that have never been sent split what's left.
        nonFreshChars += m.rendered.length;
      } else {
        freshCount++;
        nonFreshChars += m.summary.length + 2;
      }
    } else if (!prefixStable && i >= freshFrom && m.role === 'tool' && m.payload) {
      freshCount++;
      nonFreshChars += m.summary.length + 2; // the summary prefix is always sent
    } else {
      // Match the build loop: reasoning only counts where it's actually sent.
      const includeReasoning = prefixStable
        ? !(m.role === 'assistant' && m.reasoningAged)
        : i >= keepReasoningFrom;
      nonFreshChars += nonFreshChars0(m, includeReasoning);
    }
  }
  if (freshCount === 0) return undefined;

  // Work in real tokens: budget the prompt, subtract the (accurately-estimated) non-fresh
  // content, and convert what's left for fresh payloads back to chars pessimistically.
  const promptTokenBudget = (cw - reserve) * BUDGET_SAFETY;
  const nonFreshTokens = (nonFreshChars / CHARS_PER_TOKEN) * learned;
  const freshTokenBudget = promptTokenBudget - nonFreshTokens;
  if (freshTokenBudget <= 0) return 0;
  const freshCharBudget = (freshTokenBudget * CHARS_PER_TOKEN) / capCalib;
  return Math.floor(freshCharBudget / freshCount);
}

// Index from which reasoning_content is kept: the start of the Nth-most-recent tool-call
// round. Messages at or after it keep their reasoning; earlier ones are pruned. Returns
// history.length (keep none) when there are no tool-call rounds at all.
function reasoningKeepFromIndex(history: Message[], rounds: number): number {
  let seen = 0;
  let earliestToolCall = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      earliestToolCall = i;
      if (++seen === rounds) return i;
    }
  }
  // Fewer than `rounds` tool-call rounds exist: keep from the earliest one, or — if there
  // are no tool-call rounds at all — keep none (final-answer reasoning isn't needed later).
  return earliestToolCall === -1 ? history.length : earliestToolCall;
}

// Approximate the chars a message contributes to the serialized request, excluding fresh
// payloads (handled separately). Compaction recaps are already folded into systemContent,
// so they count as 0 here to avoid double-counting.
function nonFreshChars0(m: Message, includeReasoning: boolean): number {
  switch (m.role) {
    case 'user':
      return m.content.length;
    case 'assistant':
      return (
        (m.content?.length ?? 0) +
        (includeReasoning ? (m.reasoning?.length ?? 0) : 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)
      );
    case 'tool':
      return m.summary.length;
    default:
      return 0;
  }
}

// Truncate an over-budget payload, keeping the head AND the tail. Build/test/command
// output puts the signal (artifact paths, pass/fail, errors) at the *end*, so head-only
// truncation hands the model noise and hides the conclusion; we bias toward the tail.
// The marker makes clear this is a *context* limit, not the command failing — otherwise a
// model loops re-running with different flags. Full text stays in the PayloadStore.
const HEAD_FRACTION = 0.4;
function capPayload(payload: string, cap: number | undefined): string {
  if (cap === undefined || payload.length <= cap) return payload;
  const head = Math.floor(cap * HEAD_FRACTION);
  const tail = cap - head;
  const omitted = payload.length - cap;
  return (
    `${payload.slice(0, head)}\n\n` +
    `[reika: ${omitted} chars omitted from the middle to fit the context window — a ` +
    `context-size limit, not a command error; re-running won't help. Output continues:]\n\n` +
    `${payload.slice(payload.length - tail)}`
  );
}

function findToolNameForCall(history: Message[], callId: string): string | undefined {
  for (const msg of history) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    const match = msg.toolCalls.find(tc => tc.id === callId);
    if (match) return match.name;
  }
  return undefined;
}

export function toolsToOpenAI(tools: Tool[]): ChatTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
