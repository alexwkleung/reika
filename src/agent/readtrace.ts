// Instrumentation + loop detection for the question "how often, and why, does a model re-read
// content it already has?" It classifies each read against the model's prior reads this turn so a
// run yields a distribution — unique vs redundant, and for redundant, whether the prior copy was
// still in context or had aged out — and tracks per-region repeat counts so a genuine *loop*
// (the same region re-read 3+ times with identical bytes) is legible rather than bucketed with a
// one-off refetch. The classification changes nothing the model sees; the repeat counts drive the
// agent-mode loop ledger (see loop.ts: buildAgentLoopLedger).
//
// The live/aged split mirrors the harness's payload-aging boundary (provider/toolcall.ts:
// findFreshToolBlockStart). Only the most recent round's tool payloads stay in full; everything
// older collapses to summary-only. So a prior read is still visible to the model ("live") iff it
// was issued in the immediately preceding round (or this same round, as a redundant parallel call).
// A read whose prior copy is two-or-more rounds back hit a *summary*, so re-reading is the model
// re-grounding, not spinning — counting those as "loops" would overstate the problem. The repeat
// count separates the two empirically: a one-off dup-aged is a refetch; a dup-aged on its 3rd
// identical pass is a loop.
//
// `narrowed` is the escape hatch for the harness's own advice: when a payload is capped,
// capPayload (provider/toolcall.ts) tells the model to "read a narrower line range to see the
// hidden part". That recovery holds `offset` fixed and shrinks `limit` — the one axis this key
// normalizes away — so without a carve-out the rational response to truncation is indistinguishable
// from spinning, and confirms a loop on its second step (#184). See MAX_NARROWINGS.
export type ReadClass = 'unique' | 'changed' | 'narrowed' | 'dup-live' | 'dup-aged';

// A region the model is stuck re-reading: same (path, offset), unchanged bytes, repeated. The
// loop ledger names these so the stop signal is specific.
export type LoopingRead = { path: string; offset: number; repeats: number };

type Entry = {
  hash: string;
  round: number;
  repeats: number;
  path: string;
  offset: number;
  // The window this region was last requested with (Infinity when the caller doesn't track one),
  // kept only to tell a shrinking window from a repeat of the same one.
  window: number;
  // How many times the run has been restarted by a narrowing step, bounded by MAX_NARROWINGS.
  narrowings: number;
  // Whether the most recent repeat was dup-live (content still in the fresh block when re-read).
  // A dup-live repeat is never a rational refetch — the model already has the bytes — so the loop
  // policy treats it as a loop one repeat sooner than dup-aged (which can be a legitimate refetch).
  lastLive: boolean;
};

// How many times a shrinking window may restart the repeat run for one region. The bound matters
// because narrowing is only rational while it is *recovering* something: a model that has asked for
// a strictly smaller slice of the same start line this many times and still hasn't moved on is
// spinning, whatever it believes, and must be able to confirm as a loop again. Each step must be
// strictly smaller than the last, so a run is finite regardless; this caps how long it can be.
const MAX_NARROWINGS = 3;

export class ReadTrace {
  // Keyed (path, offset), limit-normalized — matches the loop's repeatKey. A model re-reading the
  // same start line with a different window is the same re-read, not forward paging to a new region.
  // The window is still carried in the entry (not the key) for the narrowing carve-out below, which
  // needs to compare against the previous request rather than fork a new region for every window.
  private seen = new Map<string, Entry>();
  private counts: Record<ReadClass, number> = {
    unique: 0,
    changed: 0,
    narrowed: 0,
    'dup-live': 0,
    'dup-aged': 0,
  };

  // `round` is the loop's per-turn round index (the outer `for` counter). It resets each turn, which
  // is correct: the fresh block only spans the active turn's history, so liveness is a within-turn
  // notion. `hash` is the whole-file hash from the read result. Returns the class plus the running
  // repeat count for this region (1 = first/just-changed), so the caller can log and detect loops.
  record(
    path: string,
    offset: number,
    hash: string,
    round: number,
    limit?: number,
  ): { cls: ReadClass; repeats: number } {
    const key = `${path}\0${offset}`;
    const prior = this.seen.get(key);
    // An absent (or nonsensical) limit reads as unbounded, so it is never *narrower* than anything
    // and callers that don't track windows keep the pre-carve-out behaviour exactly.
    const window =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : Infinity;
    let cls: ReadClass;
    let repeats: number;
    let narrowings: number;
    if (!prior) {
      cls = 'unique';
      repeats = 1;
      narrowings = 0;
    } else if (prior.hash !== hash) {
      // Same region, different bytes — the file changed since (e.g. the model edited it). A
      // legitimate refetch, never a loop; the repeat run resets so an edit-then-reread can't
      // masquerade as spinning.
      cls = 'changed';
      repeats = 1;
      narrowings = 0;
    } else if (window < prior.window && prior.narrowings < MAX_NARROWINGS) {
      // Strictly fewer lines than the request it follows: this returns *different* bytes to the
      // model, so it is a new request, not a re-read — and it is the move the omission marker asks
      // for. Restart the run rather than counting it toward one. Repeating the same narrow window
      // afterwards falls through to the dup branch below, so real spinning is still caught a round
      // later; only the descent itself is exempt.
      cls = 'narrowed';
      repeats = 1;
      narrowings = prior.narrowings + 1;
    } else {
      repeats = prior.repeats + 1;
      // distance 0 = a redundant read inside one parallel batch; distance 1 = the prior copy was
      // still in the fresh block when the model chose to re-read. Both are "live". >= 2 has aged.
      cls = round - prior.round <= 1 ? 'dup-live' : 'dup-aged';
      narrowings = prior.narrowings;
    }
    this.seen.set(key, {
      hash,
      round,
      repeats,
      path,
      offset,
      window,
      narrowings,
      lastLive: cls === 'dup-live',
    });
    this.counts[cls]++;
    return { cls, repeats };
  }

  // Regions the model is looping on, re-read within the last `recentWithin` rounds of
  // `currentRound`. Two-tier threshold: a dup-live region (content still in context — re-reading it
  // is never a refetch) qualifies at `liveMin` repeats, a dup-aged region (content aged out — one
  // re-read can be a rational refetch) only at the higher `agedMin`. So a live loop is caught a
  // round sooner, before the redundant re-reads inflate the fresh-payload bulk, while a benign
  // single refetch of aged content is never flagged. The recency gate keeps the ledger from
  // nagging about a loop the model has already broken out of (repeat counts only grow).
  loopingReads(
    currentRound: number,
    recentWithin: number,
    agedMin: number,
    liveMin: number,
  ): LoopingRead[] {
    const out: LoopingRead[] = [];
    for (const e of this.seen.values()) {
      if (currentRound - e.round > recentWithin) continue;
      const threshold = e.lastLive ? liveMin : agedMin;
      if (e.repeats >= threshold) {
        out.push({ path: e.path, offset: e.offset, repeats: e.repeats });
      }
    }
    return out;
  }

  total(): number {
    const c = this.counts;
    return c.unique + c.changed + c.narrowed + c['dup-live'] + c['dup-aged'];
  }

  summary(): string {
    const c = this.counts;
    let maxRepeat = 1;
    let looped = 0;
    for (const e of this.seen.values()) {
      if (e.repeats > maxRepeat) maxRepeat = e.repeats;
      if (e.repeats >= 3) looped++;
    }
    return (
      `unique=${c.unique} changed=${c.changed} dup-live=${c['dup-live']} dup-aged=${c['dup-aged']} ` +
      `narrowed=${c.narrowed} maxrepeat=${maxRepeat} looped=${looped}`
    );
  }
}
