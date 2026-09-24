import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { findFreshToolBlockStart } from '../provider/toolcall.js';
import { escapesProject, resolveUserPath } from '../tools/_paths.js';
import { classifyEditMatch } from '../tools/edit.js';
import type { Message } from '../types.js';

// Read-first gate (#72). Weak models blind-apply edits to files whose contents are not in front of
// them — a fresh step's old_string is then a guess. When the guess misses, the model burns a round on
// the error, reasons about it, then reads — and sometimes spirals instead of recovering. This gate
// inverts that order: the FIRST edit to an ungrounded path is withheld with a directive to read the
// file, costing one round the model needed anyway instead of a failure plus rumination.
//
// Grounding tracks LIVENESS, not history: a path is grounded only while the bytes the model would
// copy old_string from are actually being sent. The original gate kept a permanent per-turn
// `Set<string>` of paths that had ever been read, which holds only if a read stays in context for the
// rest of the turn — and it does not. In default serialization only the trailing tool block keeps its
// payloads (provider/toolcall.ts), so a read goes summary-only one round later. A 490-round turn that
// read src/ui/App.tsx at round 2 therefore counted it grounded through every subsequent fabricated
// edit, and the gate built to catch exactly that was open the whole time.
//
// Two ways to be grounded, and they expire differently:
//   - handed back: a read's payload, or an edit's post-edit echo (tools/edit.ts refreshedFile).
//     Tracked by history index and only valid while that payload is still live — see isLive.
//   - authored: a successful `write`, whose content the model composed itself. Its own tool_call
//     args carry the bytes, and assistant tool_calls are never aged, so this does not expire.
//     (`write` returns no file bytes of its own, so index-tracking it would ground nothing.)
//
// One bounce per path per turn, recorded in shouldBounce itself, makes the gate fail-open by
// construction: a model that re-issues the edit without reading gets it applied as-is, and an edit
// that ran and FAILED can never be re-bounced into its recovery loop (its path is already in the
// bounced set — the recovery ledger owns that flow).
export class ReadFirstGate {
  // path → every history index whose payload carried bytes for that file (`null` = the model authored
  // them). Indices rather than a boolean are the whole point: grounding is a fact about the current
  // request, not about the turn's past. A LIST rather than the latest one, because a file is usually
  // read in pieces — holdsRegion has to ask which of those pieces are still live.
  private grounded = new Map<string, (number | null)[]>();
  private bounced = new Set<string>();

  constructor(private cwd: string) {}

  // Model-supplied paths vary in spelling (`./src/a.ts` after reading `src/a.ts`); normalize to the
  // cwd-relative form so grounding and bouncing key the same file. Mirrors the resolve/relative
  // normalization the tools themselves apply.
  private norm(path: string): string {
    return relative(this.cwd, resolve(this.cwd, path)) || path;
  }

  // `historyIndex` is the tool message holding the bytes; omit it for authored content (`write`),
  // which never ages out of the model's own call args.
  ground(path: string, historyIndex?: number): void {
    const p = this.norm(path);
    const at = this.grounded.get(p);
    if (at) at.push(historyIndex ?? null);
    else this.grounded.set(p, [historyIndex ?? null]);
  }

  // Does the model currently hold ANY of this file's bytes? The gate's own test: a partial read is
  // judged good enough to let an edit through, since this is a nudge and not a proof.
  isGrounded(path: string, history: Message[], prefixStable = false): boolean {
    return this.entries(path).some(
      at => at === null || isLive(history, at, prefixStable), // null = authored; never ages
    );
  }

  // Does the model hold the bytes of THIS REGION — not merely of the file it lives in? The coarser
  // isGrounded is right for the gate but wrong for diagnosing a failed edit: a live read of
  // App.tsx:560-594 marks the whole file grounded, so an old_string invented for line 607 looked
  // grounded and got no help (observed, kimi-k3). Confabulation is per-region, so the test must be.
  //
  // `excerpt` is the region the edit tool located, gutter-numbered. Matching is on a probe line
  // stripped of its gutter, since the same bytes carry different line numbers depending on where a
  // read began. No probe (nothing distinctive enough) → false: on an error path the safe direction is
  // to re-send bytes the model may already have, not to withhold bytes it lacks.
  holdsRegion(path: string, excerpt: string, history: Message[], prefixStable = false): boolean {
    const entries = this.entries(path);
    if (entries.some(at => at === null)) return true; // authored: the model composed these bytes
    const probe = probeLine(excerpt);
    if (probe === undefined) return false;
    return entries.some(at => {
      if (at === null || !isLive(history, at, prefixStable)) return false;
      const m = history[at];
      return m.role === 'tool' && !!m.payload?.includes(probe);
    });
  }

  private entries(path: string): (number | null)[] {
    return this.grounded.get(this.norm(path)) ?? [];
  }

  // True exactly once per ungrounded path per turn — and recording the bounce here (a side effect)
  // is what guarantees the once: every later call for the path, grounded or not, passes.
  shouldBounce(path: string, history: Message[], prefixStable = false): boolean {
    // Never bounce a path outside the project (#216). The bounce is a directive to `read` the file,
    // and `read` applies no boundary of its own — so bouncing here is the harness walking the model
    // around the gate `write`/`edit` just applied to that same path (#175, tools/_paths.ts). This
    // gate is an ergonomics nudge for weak models; widening what the agent can reach is not
    // something it should be able to do as a side effect. Let the edit run and answer to its own
    // approval instead.
    //
    // resolveUserPath rather than this.norm: `~/…` is the shape that matters here, and norm's bare
    // resolve() would read it as a literal `~` directory inside cwd — in-project, and unbounced for
    // the wrong reason. A test pins that distinction.
    //
    // Returning before the `bounced` bookkeeping is tidiness, not policy: nothing reads that set
    // for a path this branch rejects, so recording it would be equally correct.
    if (escapesProject(this.cwd, resolveUserPath(this.cwd, path))) return false;
    const p = this.norm(path);
    if (this.bounced.has(p)) return false;
    if (this.isGrounded(path, history, prefixStable)) return false;
    this.bounced.add(p);
    return true;
  }
}

// Longest line of a gutter-numbered excerpt, stripped of its `NNNNN│` prefix — the needle for asking
// whether a payload covers that region. Longest because it is the least likely to appear incidentally
// somewhere else in the file; short and blank lines (`}`, `);`) match everywhere and prove nothing.
// Undefined when no line clears MIN_PROBE_CHARS, which is itself the answer: nothing here is
// distinctive enough to test with. Exported for tests.
const MIN_PROBE_CHARS = 12;
export function probeLine(excerpt: string): string | undefined {
  let best: string | undefined;
  for (const raw of excerpt.split('\n')) {
    const line = raw.replace(/^\s*\d+│/, '').trim();
    if (line.length >= MIN_PROBE_CHARS && (best === undefined || line.length > best.length)) {
      best = line;
    }
  }
  return best;
}

// Whether the tool payload at `index` is one the model has actually just been shown. Defers to the
// serializer's own boundary (findFreshToolBlockStart) rather than restating the rule, so the gate
// cannot drift from what the request really contains. Exported for tests.
export function isLive(history: Message[], index: number, prefixStable = false): boolean {
  const m = history[index];
  // No payload means no bytes reached the model: a large file's edit echo is dropped above
  // refreshedFile's size cap, and the `diff` rides to the UI only — it is never serialized.
  if (!m || m.role !== 'tool' || !m.payload) return false;
  // Prefix-stable keeps every payload live until batch aging marks it (agent/compaction.ts), so
  // liveness there is the mark, not the position.
  if (prefixStable) return !m.aged;
  return index >= liveFromIndex(history);
}

// First index whose tool payload was live in the request that produced the calls being dispatched
// right now. That request ended at the last assistant message, so the block that was fresh FOR IT is
// the run of tool messages immediately before that message — not the trailing block, which mid-
// dispatch is either empty or holds only this round's own results (those count too: they sit past
// this boundary, which keeps a read+edit issued in one round fail-open, as before).
function liveFromIndex(history: Message[]): number {
  let a = history.length - 1;
  while (a >= 0 && history[a].role !== 'assistant') a--;
  return a >= 0 ? findFreshToolBlockStart(history.slice(0, a)) : 0;
}

// Returned in place of the withheld edit (same contract as WITHDRAWAL_DIRECTIVE in loop.ts: no
// content that can re-fuel a loop, just the rule and the way out). Names the fail-open escape
// explicitly so a model that genuinely has the bytes is delayed one round, never blocked. States the
// absence as a fact about the context rather than about the turn — the model may well have read this
// file, twenty rounds ago, and telling it otherwise invites an argument instead of a read.
// The gate's own false-positive meter, for the `read-first bounce` debug line: would the edit it
// just withheld have applied? `yes` means the round was wasted — the model held the bytes another way
// (a bash `cat`, grep context) or reproduced them from memory; `no` means it caught a blind edit. The
// ratio across real sessions is what decides whether the default is right per model, which no
// fixture can answer. Debug-only, and never throws: a probe must not cost the turn.
export async function probeWouldLand(
  cwd: string,
  path: string,
  oldStr: string,
  newStr: string,
): Promise<string> {
  if (oldStr === '' || oldStr === newStr) return 'would-land=no match=invalid';
  let text: string;
  try {
    text = await readFile(resolveUserPath(cwd, path), 'utf8');
  } catch {
    return 'would-land=no match=unreadable';
  }
  const kind = classifyEditMatch(text, oldStr, newStr);
  const lands = kind === 'exact' || kind === 'fuzzy';
  return `would-land=${lands ? 'yes' : 'no'} match=${kind}`;
}

export function buildReadFirstDirective(path: string): string {
  return (
    `(reika: this edit was NOT applied. The current contents of ${path} are not in your context — ` +
    'either you have not read it, or the read has since aged out — so your old_string is a guess ' +
    'and will likely not match the file. Read ' +
    path +
    ' first, then re-issue the edit with old_string copied character-for-character from the read ' +
    'output — only the text after the `NNNNN│` gutter, indentation included. If you re-issue the ' +
    'edit without reading, it will be applied as-is.)'
  );
}
