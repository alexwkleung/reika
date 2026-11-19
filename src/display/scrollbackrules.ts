import type { Message } from '../types.js';
import { HIDDEN_TOOL_ARGS } from './format.js';

// The scrollback's content rules that need no terminal: which verb a read row keeps, which part of
// a notice is its lead, how a call's arguments print. Ink-free so the browser client (src/web/client)
// draws by the same rules as Scrollback.tsx.

// A "Worked for" line sits in the log beside the messages (useScrollbackLog).
export type LogItem = Message | { workedMs: number; interrupted?: boolean };

// The display form of a tool result's summary (#567, #627).
//
// A read result drops its leading verb when it is alone: the `⏺︎ Read(path=…)` call directly above
// carries it, and the path follows immediately, so the row reads cleanly without it. Stacked under
// a sibling call that argument fails — every row is `  ↳ <path> …`, the marker names none of them —
// so the verb comes back.
//
// Restoring it means *un-dropping* it, not inventing a separator: a success summary in this
// codebase is `Verb rest` (`Listed 12 entries in src`, `Found 3 matches for /x/`, `Fetched <url>
// (…)`, `Wrote src/a.ts (+3)`), and the colon-bearing shapes are failure lines (`Edit failed:`,
// `List failed:`) or `Ran:` (tools/bash.ts). A read's summary opens with the path itself, so there
// is nothing to disambiguate, and a display colon would make read the only success verb carrying a
// separator the wire format didn't.
//
// `Ran:` is the one success verb with a separator, and it is NOT a style choice to copy or undo:
// its colon is in the wire summary, where `plantrack.ts` (ranSuccessfully) parses `Ran: ` back out
// of history to re-derive plan progress for results written before `exitCode` existed. Bash is also
// the one payload that is arbitrary shell text, so the colon is what keeps `Ran: npm test` from
// reading as a command named `Ran`. Neither applies here — this row's separator would be invented
// at render time and parsed by nothing.
//
// Two of the read tool's shapes keep their verb even when lone, because for those the verb IS the
// label rather than a repetition of the call above: `Read failed: …` (an edit-style failure line)
// and `Read a.ts: offset 99 past end of file (10 lines)` (which already carries its own separator).
// Stripping either leaves `failed: …` / `a.ts: offset …`, a row that lost its only label. Matched
// on the summary's own `Verb …: detail` form, not on the mere presence of a colon, so a path that
// simply contains one (`Read a:b.ts lines 1-2 of 3`) still elides.
export function elidedReadSummary(summary: string, grouped: boolean): string {
  if (grouped || !summary.startsWith('Read ')) return summary;
  return /^\s+[^:]*:\s|^\s+failed:/.test(summary.slice('Read'.length))
    ? summary
    : summary.replace(/^Read /, '');
}

// Whether a read result is one of several under the same call round (#627). Its verb was dropped
// from the row on the argument that the call directly above carries it (#567) — an argument that
// holds only while that call is alone. With siblings, every result row is `  ↳ path …` and the
// marker names none of them, so the label goes back on the rows that lost it.
//
// Both arms read only what is knowable the moment the row prints. `<Static>` freezes a row as it
// lands, and a round's results commit one at a time (the loop runs its calls sequentially), so a
// rule that waits for the rows BELOW this one labels the first row of every stack wrong on screen
// and frozen — the very stack #627 is about. The row above is already frozen when this one prints,
// and the round's call list committed with the `⏺︎` call rows before any result ran, so those two
// decide. Cost: a read whose sibling call never commits (held for a subagent #346, withdrawn by
// the ladder) gets a label with no stack under it — a rare, stable over-label instead of a wrong
// frozen frame.
//
// The row arm keeps the gap `afterToolBlock` gives summary-only rows: a read whose neighbour
// carries a diff or a command chip is separated by a blank row, so it is not scanned as part of
// that block and keeps the bare path. The round arm is gap-proof by design: a round's results
// print in call order, so [read, bash, read] separates the two read rows with the command's block —
// the label is round-scoped ("this round read more than one file"), so no interleaving of other
// calls can strip it from a read row in a multi-read round.
export function groupedReads(
  msg: Message,
  prev: Message | undefined,
  log: readonly LogItem[],
  index: number,
): boolean {
  if (msg.role !== 'tool' || !msg.summary.startsWith('Read ')) return false;
  const nested = 'nested' in msg && !!msg.nested;
  // Same nesting level, not merely "not nested": a subagent's reads stack at the nested indent and
  // group with each other, never with a top-level row across the block boundary.
  const sibling = (m?: Message): boolean =>
    m?.role === 'tool' && !hasBlockUnderSummary(m) && !!m.nested === nested;
  return sibling(prev) || multiReadRound(msg, log, index, nested);
}

// Whether this row's round reads more than one file (#627) — the call list decides, counting every
// `read` in the round rather than looking for one after this row's call: interleaved siblings
// ([read, bash, read]) put a block between two of the read rows, and both rows deserve the label.
// The walk to the round's assistant message skips what a call can leave behind (its own result
// rows, the harness notices that trail a chip) and stops at the first same-level assistant, which
// owns these results — `callId` confirms it before the count is trusted.
function multiReadRound(
  msg: Message,
  log: readonly LogItem[],
  index: number,
  nested: boolean,
): boolean {
  if (msg.role !== 'tool') return false;
  for (let j = index - 1; j >= 0; j--) {
    const m = log[j];
    if ('workedMs' in m) continue;
    if (m.role === 'user') return false;
    if (m.role !== 'assistant') continue;
    if (!!m.nested !== nested) return false;
    const calls = m.toolCalls ?? [];
    if (!calls.some(c => c.id === msg.callId)) return false;
    return calls.filter(c => c.name === 'read').length >= 2;
  }
  return false;
}

// A lead longer than this is a sentence, not a label, and tinting it is the blob again.
const NOTICE_LEAD_MAX = 40;

// The text before a notice's first ` — ` or `: ` on its first row, colon included. Empty when
// there is none, or it is too long, or the first row wrapped before reaching it.
export function noticeLead(wrapped: string): string {
  const firstRow = wrapped.split('\n')[0];
  const m = /^(.+?)(?: — |: )/.exec(firstRow);
  if (!m) return '';
  const lead = m[0].endsWith(': ') ? m[1] + ':' : m[1];
  return lead.length <= NOTICE_LEAD_MAX ? lead : '';
}

export function hasBlockUnderSummary(msg: Message): boolean {
  return msg.role === 'tool' && !!(msg.diff || msg.command || msg.changes);
}

export function formatArgs(
  name: string,
  args: Record<string, unknown>,
  scrub: (text: string) => string = text => text,
): string {
  const hidden = HIDDEN_TOOL_ARGS[name];
  return Object.entries(args)
    .filter(([k]) => !hidden?.has(k))
    .map(([k, v]) => `${k}=${truncate(scrub(JSON.stringify(v)), 120)}`)
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
