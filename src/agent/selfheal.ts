// Self-healing restart (issue #137): the last rung of the spiral ladder, in front of the terminal
// stop. Every earlier rung — ledger, tool withdrawal, force-commit, logit recovery — ends the same
// way if it fails: the turn stops. This is the rung that instead rebuilds the turn and gives the
// model a genuine second start, so a spiral costs a restart rather than the user's request.
//
// This module holds the two pure pieces. Both are deterministic given their input, so they are
// unit-testable with no model time at all:
//   - exciseSpiral   — remove the spiral from a history WITHOUT breaking its structure.
//   - buildAppliedLedger — what is already on disk, read from tool results rather than narration.
//
// The loop integration, the budget, and the re-prompt live in loop.ts. Nothing here calls a model.
import type { Message } from '../types.js';
import { shingles } from './reasoningtrace.js';

// A round counts as ruminated when this much of its 8-gram content is k-grams the loop detector
// already flagged as recurring. Deliberately a majority rather than a trace: a round that merely
// *mentions* the rut in passing is still doing work, and dropping it would cost real context. The
// detector has already established that a loop exists — this only decides which rounds carried it.
const RUMINATION_DOMINANCE = 0.5;

export type SpiralExcision = {
  history: Message[];
  // What was removed, by kind — the numbers the `self-heal` debug line reports.
  droppedRounds: number; // whole ruminated rounds removed
  strippedReasoning: number; // rounds kept for their tool call, reasoning removed
  stubbedPayloads: number; // duplicate-read payloads collapsed to their summary
  droppedNudges: number; // harness scaffolding for the spiral being erased
  freedChars: number;
};

// Remove the spiral from `history` and return a NEW array — the input and its messages are never
// mutated, so a caller can excise speculatively (to measure) without committing.
//
// The central constraint is structural: an assistant message's tool calls and their `tool` results
// are paired by callId, and dropping either side alone produces a malformed request. So excision is
// deliberately CONTENT-level rather than structural wherever a pairing exists:
//
//   - a ruminated round with NO tool calls is removed outright (nothing references it);
//   - a ruminated round WITH tool calls keeps the call and loses only its `reasoning` — the spiral
//     lived in the reasoning, the call is real work;
//   - a looping read's `tool` message keeps its summary and loses only its payload, the same
//     outcome-preserving stub the dedup path already uses;
//   - harness nudges are removed (nothing references them, and they are scaffolding for a spiral
//     that is about to stop existing).
//
// `keepNewestReadPerPath` is why the read handling stubs rather than drops: the newest read of a
// file is the one bytes the model may still need, and a spiral is defined by re-reading, so the
// last copy is exactly the copy worth keeping.
export function exciseSpiral(
  history: Message[],
  opts: {
    // Recurring k-grams behind the loop verdict — ReasoningTrace.repeatedShingles().
    shingles: string[];
    // Paths the read detector flagged as looping — ReadTrace's looping reads.
    loopingReads?: string[];
  },
): SpiralExcision {
  const rut = new Set(opts.shingles);
  const looping = new Set(opts.loopingReads ?? []);
  const out: Message[] = [];
  let droppedRounds = 0;
  let strippedReasoning = 0;
  let stubbedPayloads = 0;
  let droppedNudges = 0;
  let freedChars = 0;

  // Which callIds belong to a looping read, and which of those is the newest — resolved in a
  // forward pass first so the rewrite below can keep the last copy of each path.
  const newestReadCall = new Map<string, string>(); // path -> callId
  const loopingCallPath = new Map<string, string>(); // callId -> path
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      // READS only. `loopingReads` comes from ReadTrace, which records nothing else, so any other
      // call carrying a `path` (an edit on the very file the model is stuck re-reading — the most
      // common shape there is) would otherwise claim the newest slot for a result that has no
      // payload, and every real read of that path would stub. That deletes the exact bytes the
      // newest-read floor exists to keep.
      if (tc.name !== 'read') continue;
      const path = typeof tc.args.path === 'string' ? tc.args.path : undefined;
      if (!path || !looping.has(path)) continue;
      loopingCallPath.set(tc.id, path);
      newestReadCall.set(path, tc.id);
    }
  }
  const keptReadCalls = new Set(newestReadCall.values());

  for (const m of history) {
    if (m.role === 'user') {
      if (m.harness) {
        droppedNudges++;
        freedChars += m.content.length;
        continue;
      }
      out.push(m);
      continue;
    }

    if (m.role === 'assistant') {
      const ruminated = isRuminated(m, rut);
      const hasCalls = (m.toolCalls?.length ?? 0) > 0;
      if (ruminated && !hasCalls) {
        droppedRounds++;
        freedChars += m.content.length + (m.reasoning?.length ?? 0);
        continue;
      }
      if (ruminated && m.reasoning) {
        strippedReasoning++;
        freedChars += m.reasoning.length;
        const { reasoning: _dropped, ...rest } = m;
        out.push(rest);
        continue;
      }
      out.push(m);
      continue;
    }

    if (m.role === 'tool') {
      const path = loopingCallPath.get(m.callId);
      const isStaleRead = path !== undefined && !keptReadCalls.has(m.callId);
      if (isStaleRead && (m.payload || m.rendered)) {
        stubbedPayloads++;
        freedChars += (m.payload?.length ?? 0) + (m.rendered?.length ?? 0);
        const { payload: _p, rendered: _r, payloadId: _pid, ...rest } = m;
        out.push(rest);
        continue;
      }
      out.push(m);
      continue;
    }

    out.push(m);
  }

  return {
    history: out,
    droppedRounds,
    strippedReasoning,
    stubbedPayloads,
    droppedNudges,
    freedChars,
  };
}

// Whether this round's text is dominated by the rut. Measured over reasoning AND content with the
// same 8-gram tokenizer the detector used, so "the rut" means the same thing in both places. A
// round too short to shingle is never ruminated — there is nothing to conclude from it, and the
// conservative answer keeps context.
function isRuminated(m: Message & { role: 'assistant' }, rut: Set<string>): boolean {
  if (rut.size === 0) return false;
  const sh = shingles(`${m.reasoning ?? ''}\n${m.content}`);
  if (sh.length === 0) return false;
  let hits = 0;
  for (const s of sh) if (rut.has(s)) hits++;
  return hits / sh.length >= RUMINATION_DOMINANCE;
}

export type AppliedChange = {
  path: string;
  // How the file was touched. `write` wins over `edit` for a path touched both ways: it is the
  // stronger claim (whole-file), and the restart only needs to know the file is not pristine.
  kind: 'edit' | 'write';
  edits: number;
  added: number;
  removed: number;
};

// What this turn has ALREADY put on disk, derived from the `tool` results the edits produced —
// never from the assistant's own account of what it did.
//
// That distinction is the whole point. A re-prompted model starts without the memory of its own
// edits, and if it is told what it changed by a narration that a spiral wrote, it will redo work or
// claim work it never did. Tool results are the harness's own record: `diff` is attached by the edit
// tool when the write actually landed, so a call that failed contributes nothing here.
//
// Pairs assistant tool calls to their results by callId and counts only the calls that produced a
// diff — a failed or rejected edit leaves the file pristine and must not appear as applied.
export function buildAppliedLedger(history: Message[]): AppliedChange[] {
  const callKind = new Map<string, { path: string; kind: 'edit' | 'write' }>();
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if (tc.name !== 'edit' && tc.name !== 'write') continue;
      if (typeof tc.args.path !== 'string') continue;
      callKind.set(tc.id, { path: tc.args.path, kind: tc.name });
    }
  }

  const byPath = new Map<string, AppliedChange>();
  for (const m of history) {
    if (m.role !== 'tool' || !m.diff) continue;
    const call = callKind.get(m.callId);
    if (!call) continue;
    // The diff's own path is authoritative when present (the tool resolves relative paths); the
    // call's path is the fallback for a result that recorded no path of its own.
    const path = m.diff.path || call.path;
    const prev = byPath.get(path);
    if (prev) {
      prev.edits++;
      prev.added += m.diff.added;
      prev.removed += m.diff.removed;
      if (call.kind === 'write') prev.kind = 'write';
    } else {
      byPath.set(path, {
        path,
        kind: call.kind,
        edits: 1,
        added: m.diff.added,
        removed: m.diff.removed,
      });
    }
  }
  return [...byPath.values()];
}

// Render the ledger as the block the restart prompt opens with. Empty string when nothing landed,
// so a restart on a turn that never edited says nothing about files rather than saying "none" —
// a distinction that matters, since "no changes yet" is itself a claim the model would act on.
//
// Phrased as instruction, not narration: the failure this guards against is the model re-applying
// work, so the block has to tell it to verify before touching those files again.
export function formatAppliedLedger(changes: AppliedChange[]): string {
  if (changes.length === 0) return '';
  const lines = changes.map(c => {
    const counts = `+${c.added}/-${c.removed}`;
    const times = c.edits > 1 ? `, ${c.edits} edits` : '';
    return `  - ${c.path} (${counts}${times})`;
  });
  return (
    'Changes from this turn are ALREADY saved to disk:\n' +
    `${lines.join('\n')}\n` +
    'Read these files before changing them again — do not re-apply work that is already there.'
  );
}
