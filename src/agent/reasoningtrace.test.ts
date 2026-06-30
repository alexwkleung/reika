import { describe, expect, it } from 'vitest';
import {
  selfRepeatRatio,
  crossRoundSimilarity,
  ReasoningTrace,
  liveSpinSignal,
  verbatimAbortThreshold,
} from './reasoningtrace.js';

// A spread of distinct words so healthy prose never accidentally repeats an 8-gram.
const HEALTHY =
  'the user wants a toggle in settings so we open the panel and add a switch ' +
  'bound to a new config flag then persist it across reloads and render the label';

describe('selfRepeatRatio', () => {
  it('is ~0 for healthy non-repeating reasoning', () => {
    expect(selfRepeatRatio(HEALTHY)).toBe(0);
  });

  it('returns 0 for text too short to shingle', () => {
    expect(selfRepeatRatio('too short to form an eight word shingle')).toBe(0);
  });

  it('climbs toward 1 as a span is re-emitted verbatim (Layer 1)', () => {
    const span = 'wait let me reconsider this carefully actually the answer is clearly ';
    const degenerate = span.repeat(10);
    expect(selfRepeatRatio(degenerate)).toBeGreaterThan(0.8);
  });

  it('partial repetition lands between the extremes', () => {
    const ratio = selfRepeatRatio(HEALTHY + ' ' + HEALTHY);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });
});

describe('crossRoundSimilarity', () => {
  it('is ~1 for identical reasoning across rounds (Layer 2)', () => {
    expect(crossRoundSimilarity(HEALTHY, HEALTHY)).toBeCloseTo(1, 5);
  });

  it('is 0 for disjoint reasoning', () => {
    const other =
      'first we benchmark the parser then profile the hot path and cache the regex ' +
      'compilation before measuring throughput again on the larger corpus of files';
    expect(crossRoundSimilarity(HEALTHY, other)).toBe(0);
  });

  it('is high when a round restates most of the prior round (rumination)', () => {
    const next = HEALTHY + ' but is the feature already implemented or not';
    expect(crossRoundSimilarity(HEALTHY, next)).toBeGreaterThan(0.6);
  });

  it('is 0 when either side is too short to shingle', () => {
    expect(crossRoundSimilarity(HEALTHY, 'short')).toBe(0);
  });
});

describe('liveSpinSignal', () => {
  it('does not flag short reasoning, however repetitive (ratio 0 under min length)', () => {
    const r = liveSpinSignal('wait reconsider '.repeat(5));
    expect(r.spinning).toBe(false);
    expect(r.ratio).toBe(0);
  });

  it('does not flag long healthy reasoning', () => {
    // Distinct sentences padded past the min length stay well under the ratio.
    const healthy = Array.from(
      { length: 80 },
      (_, n) =>
        `step ${n} examines a distinct concern number ${n} in the codebase and resolves it.`,
    ).join(' ');
    expect(healthy.length).toBeGreaterThan(1200);
    expect(liveSpinSignal(healthy).spinning).toBe(false);
  });

  it('flags a long block whose trailing window degenerates into a repeated span', () => {
    const lead = 'first some genuine and varied analysis of the problem at hand goes here. '.repeat(
      20,
    );
    const spiral = 'wait let me reconsider this carefully actually the answer is clearly '.repeat(
      40,
    );
    const r = liveSpinSignal(lead + spiral);
    expect(r.spinning).toBe(true);
    expect(r.ratio).toBeGreaterThan(0.3);
  });

  it('flags paragraph-recycling whose period exceeds the old small window', () => {
    // The real failure case: a ~400-char paragraph recycled, separated by ~400 chars of filler, so
    // the period (~800 chars) is larger than the old 2400 window would reliably catch but the wide
    // window sees the recycling. Distinct fillers keep it from being a trivial verbatim loop.
    const para =
      'But actually I think the issue is that the textarea is using inset zero which makes it fill ' +
      'the entire container and the padding right creates space for the gutter but if the text is ' +
      'very long it might still overflow into the gutter area because the padding is not enough here. ';
    let block = '';
    for (let n = 0; n < 8; n++) {
      block += `Consideration number ${n} explores a separate distinct angle ${n} on the layout. `;
      block += para; // the same paragraph recycled every cycle
    }
    expect(liveSpinSignal(block).spinning).toBe(true);
  });

  it('separates verbatim degeneration (auto-abort tier) from heavy recycling (hint tier)', () => {
    // A verbatim decoder loop saturates the ratio (>0.75 — the auto-abort threshold in loop.ts);
    // measured ~0.9 on a real transcript. Even HEAVY paragraph-recycling (distinct fillers between
    // repeats) stays in the hint band below 0.75, so the auto-cut never fires on a non-verbatim spiral.
    const verbatim =
      'the exact same sentence over and over with no variation at all right here now. '.repeat(30);
    expect(liveSpinSignal(verbatim).ratio).toBeGreaterThan(0.75);

    const para =
      'But actually I think the issue is that the textarea uses inset zero to fill the container and ' +
      'the padding creates the gutter space but long text overflows anyway here in this layout. ';
    let recycling = '';
    for (let n = 0; n < 8; n++) {
      recycling += `Consideration number ${n} explores a wholly separate ${n} concern about spacing. `;
      recycling += para;
    }
    const r = liveSpinSignal(recycling);
    expect(r.spinning).toBe(true); // ≥ 0.3 → gets the soft hint
    expect(r.ratio).toBeLessThan(0.75); // but below the auto-abort threshold
  });
});

describe('verbatimAbortThreshold', () => {
  it('requires the high (verbatim-only) bar for a normal-length block', () => {
    expect(verbatimAbortThreshold(0)).toBe(0.75);
    expect(verbatimAbortThreshold(16000)).toBe(0.75); // at/below the length floor
  });

  it('lowers the bar toward the floor as a single block grows pathologically long', () => {
    expect(verbatimAbortThreshold(40000)).toBe(0.4); // at/above the upper length
    const mid = verbatimAbortThreshold(22000); // between the two lengths
    expect(mid).toBeLessThan(0.75);
    expect(mid).toBeGreaterThan(0.4);
  });

  it('is monotonically non-increasing in length', () => {
    const lens = [0, 16000, 20000, 24000, 28000, 50000];
    const ts = lens.map(verbatimAbortThreshold);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
  });
});

describe('ReasoningTrace', () => {
  const T = 0.6;
  const A = HEALTHY;
  const B =
    'instead we should profile the renderer first and only then decide whether the ' +
    'memoization actually helps before touching any of the existing component code paths';

  it('reports no streak across distinct, converging rounds', () => {
    const t = new ReasoningTrace();
    expect(t.record(A, T).streak).toBe(0); // first round: no prior
    expect(t.record(B, T).streak).toBe(0); // disjoint from A
  });

  it('builds a streak as identical reasoning repeats (the observed loop)', () => {
    const t = new ReasoningTrace();
    expect(t.record(A, T).streak).toBe(0);
    const r2 = t.record(A, T); // crossSim ~1.0 vs prior
    expect(r2.sim).toBeCloseTo(1, 5);
    expect(r2.streak).toBe(1);
    expect(t.record(A, T).streak).toBe(2); // fires at streak >= 2
    expect(t.record(A, T).streak).toBe(3);
  });

  it('resets the streak when the model breaks out of the loop', () => {
    const t = new ReasoningTrace();
    t.record(A, T);
    expect(t.record(A, T).streak).toBe(1);
    expect(t.record(B, T).streak).toBe(0); // fresh reasoning clears it
  });

  it('an empty (tool-only) round resets the streak conservatively', () => {
    const t = new ReasoningTrace();
    t.record(A, T);
    expect(t.record(A, T).streak).toBe(1);
    expect(t.record('', T).streak).toBe(0);
    expect(t.record(undefined, T).streak).toBe(0);
  });

  // Paraphrases A: keeps A's first ~22 words, then drifts — Jaccard lands in the warm band
  // (>= T*0.5, < T) rather than at/above the fire threshold. The streak tests assert that band
  // as a precondition so a mis-constructed string fails loudly rather than silently passing.
  const WARM =
    'the user wants a toggle in settings so we open the panel and add a switch ' +
    'bound to a new config flag but we should defer this entire effort to a later milestone';

  it('catches an echo of a round two back that a prev-only comparison would miss', () => {
    const t = new ReasoningTrace();
    t.record(A, T); // window: [A]
    t.record(B, T); // an intervening distinct round; prev-only would see B and reset
    const r = t.record(A, T); // A again — echoes two rounds back, not the immediate prior (B)
    expect(r.sim).toBeCloseTo(1, 5); // windowed max finds the A two back
    expect(r.streak).toBe(1); // counts as a loop round despite the intervening B
  });

  it('holds the streak through a single paraphrased (warm) dip instead of zeroing', () => {
    // Precondition: WARM is similar-but-not-firing relative to A.
    expect(crossRoundSimilarity(A, WARM)).toBeGreaterThanOrEqual(T * 0.5);
    expect(crossRoundSimilarity(A, WARM)).toBeLessThan(T);
    const t = new ReasoningTrace();
    t.record(A, T);
    expect(t.record(A, T).streak).toBe(1); // identical → streak builds
    expect(t.record(WARM, T).streak).toBe(1); // warm dip HOLDS at 1 (a hard reset would zero it)
    expect(t.record(A, T).streak).toBe(2); // next clear match resumes building → fires at >= 2
  });

  it('exposes the recurring shingles while looping and clears them on break', () => {
    const t = new ReasoningTrace();
    t.record(A, T);
    expect(t.repeatedShingles()).toEqual([]); // first round, no prior to intersect
    t.record(A, T); // identical → looping
    const repeated = t.repeatedShingles();
    expect(repeated.length).toBeGreaterThan(0);
    // The recurring k-grams are drawn from the ruminated text itself.
    expect(repeated.every(s => A.toLowerCase().includes(s))).toBe(true);
    t.record(B, T); // fresh reasoning breaks the loop
    expect(t.repeatedShingles()).toEqual([]);
  });
});
