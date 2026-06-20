import type { Message } from '../types.js';
import { DEFAULT_MIN_GEN_TOKENS } from '../provider/budget.js';

// Keep in sync with CHARS_PER_TOKEN in ../provider/tokens.ts.
const CHARS_PER_TOKEN = 4;
// Post-compaction budgets as a fraction of the *available* window (total minus the
// generation reserve): recent turns kept verbatim, and the recap of everything older.
// Sized conservatively so kept + recap + system stays under the trigger even when a model
// tokenizes denser than the heuristic — and so the recap can't grow without bound.
const KEEP_FRACTION = 0.3;
const RECAP_FRACTION = 0.1;
// Per-entry text budget inside the recap.
const MAX_TEXT = 240;
// Slack against estimate error: trigger compaction slightly before the prompt would
// actually leave less than the generation reserve, not exactly at the wall.
const COMPACT_SAFETY = 0.9;

// Tokens of room available for the prompt: the window minus the generation reserve.
// Compaction targets this so kept history + recap leave room for the model's reply.
// Guards a nonsensical reserve ≥ window by falling back to half the window.
function availTokens(window: number, minGen: number): number {
  const avail = window - minGen;
  return avail > 0 ? avail : Math.floor(window / 2);
}

// The calibrated prompt-token count at which compaction should fire: just under the room
// left once the generation reserve is set aside. Exported for tests and the loop's gauge.
export function compactThreshold(window: number, minGen = DEFAULT_MIN_GEN_TOKENS): number {
  return availTokens(window, minGen) * COMPACT_SAFETY;
}

export function shouldCompact(
  promptTokens: number,
  contextWindow?: number,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): boolean {
  return !!contextWindow && promptTokens > compactThreshold(contextWindow, minGen);
}

// Collapse older turns into a single `compaction` message, in place, so the request fits
// the window. Keeps as much recent history verbatim as fits the keep budget (snapped to a
// user-message boundary, so no tool result is ever split from its tool_call) and condenses
// the rest into a size-bounded recap. Returns the number of messages removed (0 = nothing
// safe to do). Lossless by reference: raw tool payloads stay in the PayloadStore.
export function compactHistory(
  history: Message[],
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): number {
  if (!contextWindow) return 0;
  // Budgets are in chars but the window is in tokens; divide by the learned char→token
  // calibration so "30% of the available window" holds in *real* tokens, not the
  // heuristic's. Sized off the available room (window − reserve) so the result fits under
  // the trigger even when the reserve is a large fraction of a small window.
  const calib = calibration > 0 ? calibration : 1;
  const avail = availTokens(contextWindow, minGen);
  const keepBudget = (avail * CHARS_PER_TOKEN * KEEP_FRACTION) / calib;

  // Walk back from the end, keeping recent messages until the keep budget is spent.
  let chars = 0;
  let keepFrom = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    chars += msgChars(history[i]);
    if (chars > keepBudget) break;
    keepFrom = i;
  }
  // Snap keepFrom back to the start of its tool-call group so a kept tool result is never orphaned
  // from the assistant tool_call it answers (a bare leading tool message is an API error). Walking
  // *back* to a group boundary — rather than the old *forward* snap to a user message — is what lets
  // compaction engage *within* a single long turn. Plan-mode exploration is one user message
  // followed by dozens of tool rounds with no later user boundary; the old rule found none, clamped
  // to "keep everything", and the request grew unbounded until the server rejected it.
  while (keepFrom > 0 && history[keepFrom].role === 'tool') keepFrom--;
  // Preserve the original request verbatim: if the conversation opens with the user's task, keep it
  // at index 0 and recap only what follows — a long exploration must never compact away the very
  // thing it's planning for. A leading slash-command echo (meta) is not the task, so don't pin it.
  const first = history[0];
  const recapStart = first && first.role === 'user' && !first.meta ? 1 : 0;
  if (keepFrom <= recapStart) return 0;

  const recap = buildRecap(history.slice(recapStart, keepFrom), avail, calib);
  history.splice(recapStart, keepFrom - recapStart, { role: 'compaction', content: recap });
  return keepFrom - recapStart;
}

// Approximate the characters a message contributes to a request (at rest: tool payloads
// are already summarized by aging, so only the summary counts).
function msgChars(m: Message): number {
  switch (m.role) {
    case 'user':
      return m.content.length;
    case 'assistant':
      return (
        (m.content?.length ?? 0) +
        (m.reasoning?.length ?? 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)
      );
    case 'tool':
      return m.summary.length;
    case 'compaction':
      return m.content.length;
    default:
      return 0;
  }
}

// Deterministic recap of an older span — selection, not generation. Each turn's intent and
// conclusion, aggregate tool usage, and files touched, bounded to RECAP_FRACTION of the
// window: when there's more than fits, the most recent turns are kept and the rest are
// noted as a count. Any prior recap in the span is carried forward.
function buildRecap(span: Message[], avail: number, calib: number): string {
  const recapBudget = (avail * CHARS_PER_TOKEN * RECAP_FRACTION) / calib;
  const priorRecaps: string[] = [];
  const entries: string[] = [];
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  let pending: string | null = null;

  const flush = (): void => {
    if (pending !== null) {
      entries.push(pending);
      pending = null;
    }
  };

  for (const m of span) {
    if (m.role === 'compaction') {
      priorRecaps.push(m.content);
    } else if (m.role === 'user' && !m.meta) {
      // Skip slash-command echoes — they're UI-only and must not re-enter context via the recap.
      flush();
      pending = `- User: ${trunc(m.display ?? m.content)}`;
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
        const p = tc.args.path;
        if (typeof p === 'string') files.add(p);
      }
      if (m.content?.trim()) {
        const line = `  → ${trunc(m.content)}`;
        pending = pending ? `${pending}\n${line}` : line;
      }
    }
  }
  flush();

  // Keep the most recent entries that fit the recap budget; count the rest as omitted.
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const len = entries[i].length + 1;
    if (used + len > recapBudget && kept.length > 0) {
      omitted = i + 1;
      break;
    }
    kept.unshift(entries[i]);
    used += len;
  }

  const out: string[] = [];
  if (priorRecaps.length > 0) out.push(priorRecaps.join('\n\n'));
  if (omitted > 0) out.push(`(+${omitted} earlier turn${omitted === 1 ? '' : 's'} condensed)`);
  if (kept.length > 0) out.push(kept.join('\n'));

  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
  if (toolSummary) out.push(`Tools used: ${toolSummary}`);
  if (files.size > 0) {
    // Cap the file list so the recap can't grow unbounded with a long session.
    const sorted = [...files].sort();
    const shown = sorted.slice(0, 25).join(', ');
    const extra = sorted.length > 25 ? `, +${sorted.length - 25} more` : '';
    out.push(`Files touched: ${shown}${extra}`);
  }
  out.push('(Older tool outputs were omitted here but can be re-read on demand.)');

  return out.join('\n\n');
}

function trunc(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT - 1) + '…' : flat;
}
