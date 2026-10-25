import type { Message, ToolCall } from '../types.js';

// EXPERIMENT (#280, REIKA_COMPACTION_REPORT=1): a report round before each compaction fold.
//
// The recap a fold leaves behind is a ledger of reads — "Read src/ui/Approval.tsx lines 1-112" —
// with none of what was found in them; the model's conclusions live in reasoning, which the fold
// drops. Measured on the #335 A/B (2026-09-14): the un-delegated arm had every file the answer
// needed by round 6, then folded FIVE times and re-read them after each fold ("Approval.tsx? Not
// yet" — it had read it at round 8), 3h01m, no answer. The delegated arm's subagent was forced to
// write its findings at its cap (#344) and the parent answered 7/7 from that digest in 2h17m. Same
// model, same files. The difference is that one path was asked for its findings before they were
// dropped. This is that ask, on the parent path: when a fold is due, spend one reply — tools
// withdrawn — on a compaction note, then fold with the note as the recap's body.
//
// The note is the model's own writing, so it is what the model would re-derive anyway; the round
// costs one generation (its prefill is append-only on a context the fold is about to reprocess).
// Numbered so the model knows how many folds it has been through, and each note supersedes the
// last: the model can see the previous note in the recap when it writes the next one, and is told
// to carry forward what still matters. One note in the recap, never a stack (#275).
//
// Flag read per call so toggling needs no restart; strict no-op when off — the baseline arm's
// requests are byte-identical.

// On by default since 2026-09-15: three folds on the payload-lifecycle prompt carried the note
// (1→2 complete with the clamp out of the way; 3 degraded to a reasoning fallback but still on
// target), and the trace prompt went 11 rounds / 1 fold / 7-of-7 against a baseline that folded
// five times and never answered. `0` keeps the baseline arm reproducible.
export function compactionReportEnabled(): boolean {
  return process.env.REIKA_COMPACTION_REPORT !== '0';
}

// Sent once when the report round's reply carried no note in the content channel. Observed on the
// third fold of a run at 91% context: the model ignored "tools are withdrawn", emitted an in-band
// tool call (stripped, leaving content empty), and its reasoning ended in "Let me search for those
// function calls to verify" — a thinking stream, not a note. The reasoning fallback still catches
// that, but as first-person prose with no file:line refs and no open list. One retry, then the
// fallback: a second generation is cheap next to the fold's reprocess, and bounded.
export const COMPACTION_REPORT_RETRY =
  '(reika: your reply carried no note — the content was empty or was a tool call, and tools are ' +
  'withdrawn for this reply. Write the compaction note now, as your reply, not as a tool call: ' +
  'what you have established with file paths and function names, then what is still open.)';

type NoteReply = {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
};

// What a call made in the note round gets back (#806). Re-sending the same request with a longer
// directive left the model never seeing its call refused, and LFM2.5, a pruned qwen3.6-35b-a3b
// and qwen3.8-27b each called again; banning the call token at the sampler only moved the call
// into other dialects. A refused call in its own dialect is what these models recover from (the
// read-withdrawal refusal is the same move), and appended it costs no re-prefill.
export const COMPACTION_CALL_REFUSED =
  'Not run: tools are unavailable while the compaction note is written. Write the note as your ' +
  'reply now.';

// The turn the retry appends after a reply that called: that reply, and a refusal for each call.
// Request-only — never pushed to history. Empty when the reply made no call.
export function refusedCallTurn(reply: NoteReply): Message[] {
  if (!reply.toolCalls?.length) return [];
  return [
    {
      role: 'assistant',
      content: reply.content ?? '',
      reasoning: reply.reasoning,
      toolCalls: reply.toolCalls,
    },
    ...reply.toolCalls.map((c): Message => ({
      role: 'tool',
      callId: c.id,
      summary: COMPACTION_CALL_REFUSED,
    })),
  ];
}

// A reply that made a call has no note in its content, only the call's preamble ("Let me examine
// `_net.ts` in detail:"): observed recapped as note 1 under the own-words header while that reply's
// 970-char reasoning — the actual findings — was dropped (#799). Text-format callers (LFM) call
// through `tool_choice: 'none'`, so this is not rare.
export function compactionNoteContent(reply: NoteReply): string {
  if (reply.toolCalls?.length) return '';
  return reply.content?.trim() ?? '';
}

// Content from a call-free reply wins; otherwise the longer reasoning of the two replies. Longer
// rather than first: the first was assumed the less nagged thinking, but a reply that bails into a
// call early is short exactly because it stopped thinking (#799: 111 chars against 970).
export function pickCompactionNote(
  first: NoteReply,
  retry?: NoteReply,
): { text: string; reasoning?: string; src: 'content' | 'reasoning' | 'empty' } {
  for (const r of [first, retry]) {
    if (!r) continue;
    const text = compactionNoteContent(r);
    if (text) return { text, reasoning: r.reasoning?.trim() || undefined, src: 'content' };
  }
  const a = first.reasoning?.trim() ?? '';
  const b = retry?.reasoning?.trim() ?? '';
  const best = b.length > a.length ? b : a;
  // No trace beside it: the note IS the reasoning, and the UI would draw the same text twice.
  return best ? { text: best, src: 'reasoning' } : { text: '', src: 'empty' };
}

// The note round's reply is started for the model, on a local engine (#806). The round continues an
// agent transcript, and a small model's strongest prior there is the next action: LFM2.5 called a
// tool instead of writing the note on every T2 fold (0 of 21 notes from the reply), through the
// directive, the sampler ban and the refused-call retry alike. Handed a reply that is already a
// note, it continued it: 3 of 3 notes, 0 calls, on llama.cpp (the reasoning block is skipped).
// Ends on a newline — ending on "- " started bullets with junk. `0` is the baseline arm.
export function notePrefillEnabled(): boolean {
  return process.env.REIKA_NOTE_PREFILL !== '0';
}

const NOTE_PREFILL_BODY = 'Established:\n';

export function compactionNotePrefill(n: number): string {
  return `Compaction note ${n}\n\n${NOTE_PREFILL_BODY}`;
}

// Below this, a prefilled reply that ends in a call is a lead-in ("Established:\nLet me check
// X"), not a note, and stays a call.
export const PREFILLED_NOTE_MIN_CHARS = 200;

// A prefilled reply as the note it continues. llama.cpp returns the prefill inside `content`, an
// engine that does not continue it returns only what came after, so both shapes are accepted. The
// title line is dropped (the recap carries its own header), and a reply that wrote nothing after
// the prefill is no note: the prefill alone would otherwise pass as one. A call after a written
// note is dropped (`callsDropped`) rather than voiding it: LFM2.5 wrote 1206 chars of note and then
// called, on both attempts, and #799's rule threw both notes away. That rule is about an
// unprefilled reply, whose text is the call's preamble; here the text is the note by construction.
//
// The prefill skips the reasoning block, and LFM2.5 then writes its next-step thinking after the
// note and closes it with a bare `</think>` (both folds of lfm16-prefill-2), so the reply is cut at
// that tag. The thinking just before it stays: there is no reliable edge, and `fitNote` drops the
// note's tail first.
export function prefilledReply<T extends NoteReply>(
  reply: T,
  prefill: string,
): T & { callsDropped?: number } {
  const raw = reply.content ?? '';
  const continued = raw.startsWith(prefill) ? raw.slice(prefill.length) : raw;
  const close = continued.indexOf('</think>');
  const before = close === -1 ? continued : continued.slice(0, close).trimEnd();
  // A tag closed at once puts the note after it instead.
  const rest = before.trim() || close === -1 ? before : continued.slice(close + 8).trimStart();
  if (!rest.trim()) return { ...reply, content: '' };
  const content = NOTE_PREFILL_BODY + rest;
  const calls = reply.toolCalls?.length ?? 0;
  if (calls && rest.trim().length >= PREFILLED_NOTE_MIN_CHARS) {
    return { ...reply, content, toolCalls: undefined, callsDropped: calls };
  }
  return { ...reply, content };
}

// Hard cap on a note — a runaway guard only. The directive asks for ~1500 chars and the fold sizes
// the note under NOTE_SHARE of the recap budget (`fitNote`), which is the real bound. This used to
// be 2400 and bit first: a 2400+ char note was cut here while the recap still had room, and the
// cut landed in its "still open" list — the half the parent reads next. 4000 clears the recap
// budget at every window that folds (≈ 4.2k chars at 24k) so `fitNote` decides, not this.
export const COMPACTION_NOTE_MAX_CHARS = 4000;

export function buildCompactionReportDirective(n: number): string {
  return (
    '(reika: the context is about to be compacted — older tool output will be folded into a ' +
    'short recap and its bytes will be gone. Tools are withdrawn for this one reply. Write a ' +
    `compaction note for yourself (note ${n} of this session), under 1500 characters: what you ` +
    'have established so far, with file paths and function names; any exact string the task asked ' +
    'for, quoted; and what is still open. If an earlier note is in the recap above, carry forward ' +
    'what it says that still matters. The note replaces the folded history, so write what you ' +
    'would otherwise have to re-read. Do not answer the task and do not ask to continue — just ' +
    'the note.)'
  );
}

export function clampCompactionNote(text: string): string {
  const t = text.trim();
  if (t.length <= COMPACTION_NOTE_MAX_CHARS) return t;
  return t.slice(0, COMPACTION_NOTE_MAX_CHARS - 1).trimEnd() + '…';
}

// The header the recap puts over the note. Says whose words these are: the model reasons very
// differently from "a tool said" and from "I concluded", and a note under a tool-output header
// would be re-verified as second-hand — the exact re-read the note exists to prevent.
export function compactionNoteHeader(n: number): string {
  return `Your compaction note ${n} (written by you just before this fold — your own conclusions, not tool output):`;
}
