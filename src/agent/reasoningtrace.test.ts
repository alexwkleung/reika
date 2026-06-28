import { describe, expect, it } from 'vitest';
import {
  selfRepeatRatio,
  crossRoundSimilarity,
  ReasoningTrace,
  liveSpinSignal,
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
  it('does not flag short reasoning, however repetitive', () => {
    expect(liveSpinSignal('wait reconsider '.repeat(5))).toBe(false); // under the min length
  });

  it('does not flag long healthy reasoning', () => {
    // Distinct sentences padded past the min length stay well under the ratio.
    const healthy = Array.from(
      { length: 80 },
      (_, n) => `step ${n} examines a distinct concern number ${n} in the codebase and resolves it.`,
    ).join(' ');
    expect(healthy.length).toBeGreaterThan(1200);
    expect(liveSpinSignal(healthy)).toBe(false);
  });

  it('flags a long block whose trailing window degenerates into a repeated span', () => {
    const lead = 'first some genuine and varied analysis of the problem at hand goes here. '.repeat(20);
    const spiral = 'wait let me reconsider this carefully actually the answer is clearly '.repeat(40);
    expect(liveSpinSignal(lead + spiral)).toBe(true);
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
    expect(liveSpinSignal(block)).toBe(true);
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
});
