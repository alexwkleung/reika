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
