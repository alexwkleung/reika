import { relative, resolve } from 'node:path';

// Read-first gate (#72). During plan-step execution, weak models blind-apply edits to files they
// have not read this turn — the handoff digest keeps the plan verbatim but not file bytes, so a
// fresh step's old_string is a guess. When the guess misses, the model burns a round on the error,
// reasons about it, then reads — and sometimes spirals instead of recovering. This gate inverts
// that order: the FIRST edit to an ungrounded path is withheld with a directive to read the file,
// costing one round the model needed anyway instead of a failure plus rumination.
//
// Grounding is per-turn (constructed fresh in runTurn, like ReadTrace): after a turn boundary the
// prior read's payload has aged to summary-only, so re-requiring a read is re-grounding, not a tax.
// A path is grounded by a read (any window — a partial read is judged good enough; this is a nudge,
// not a proof) or by a successful edit/write, whose result carries the post-edit bytes
// (refreshedFile / the diff). One bounce per path per turn, recorded in shouldBounce itself, makes
// the gate fail-open by construction: a model that re-issues the edit without reading gets it
// applied as-is, and an edit that ran and FAILED can never be re-bounced into its recovery loop
// (its path is already in the bounced set — the recovery ledger owns that flow).
export class ReadFirstGate {
  private grounded = new Set<string>();
  private bounced = new Set<string>();

  constructor(private cwd: string) {}

  // Model-supplied paths vary in spelling (`./src/a.ts` after reading `src/a.ts`); normalize to the
  // cwd-relative form so grounding and bouncing key the same file. Mirrors the resolve/relative
  // normalization the tools themselves apply.
  private norm(path: string): string {
    return relative(this.cwd, resolve(this.cwd, path)) || path;
  }

  ground(path: string): void {
    this.grounded.add(this.norm(path));
  }

  // True exactly once per ungrounded path per turn — and recording the bounce here (a side effect)
  // is what guarantees the once: every later call for the path, grounded or not, passes.
  shouldBounce(path: string): boolean {
    const p = this.norm(path);
    if (this.grounded.has(p) || this.bounced.has(p)) return false;
    this.bounced.add(p);
    return true;
  }
}

// Returned in place of the withheld edit (same contract as WITHDRAWAL_DIRECTIVE in loop.ts: no
// content that can re-fuel a loop, just the rule and the way out). Names the fail-open escape
// explicitly so a model that genuinely has the bytes is delayed one round, never blocked.
export function buildReadFirstDirective(path: string): string {
  return (
    `(reika: this edit was NOT applied. You have not read ${path} this turn, so your old_string ` +
    'is a guess and will likely not match the file. Read ' +
    path +
    ' first, then re-issue the edit with old_string copied character-for-character from the read ' +
    'output — only the text after the `NNNNN│` gutter, indentation included. If you re-issue the ' +
    'edit without reading, it will be applied as-is.)'
  );
}
