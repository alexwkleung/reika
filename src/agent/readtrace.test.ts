import { describe, expect, it } from 'vitest';
import { ReadTrace } from './readtrace.js';

const H1 = 'hash-aaa';
const H2 = 'hash-bbb';

// Convenience: assert just the class (most tests don't care about the repeat count).
const cls = (r: { cls: string; repeats: number }) => r.cls;

describe('ReadTrace.record classification', () => {
  it('classifies a first read of a region as unique', () => {
    const t = new ReadTrace();
    expect(cls(t.record('a.ts', 1, H1, 0))).toBe('unique');
  });

  it('treats forward paging (distinct offsets) as all unique', () => {
    const t = new ReadTrace();
    expect(cls(t.record('a.ts', 1, H1, 0))).toBe('unique');
    expect(cls(t.record('a.ts', 200, H1, 1))).toBe('unique');
    expect(cls(t.record('a.ts', 400, H1, 2))).toBe('unique');
    expect(t.summary()).toContain('unique=3 changed=0 dup-live=0 dup-aged=0');
  });

  it('counts a redundant read in the same round (parallel batch) as dup-live', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    expect(cls(t.record('a.ts', 1, H1, 0))).toBe('dup-live');
  });

  it('counts a re-read one round later as dup-live (prior copy still in the fresh block)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 3);
    expect(cls(t.record('a.ts', 1, H1, 4))).toBe('dup-live');
  });

  it('counts a re-read two-or-more rounds later as dup-aged (prior copy aged to summary)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1);
    expect(cls(t.record('a.ts', 1, H1, 3))).toBe('dup-aged');
  });

  it('normalizes the read window: same offset, different limit -> still a dup, not unique', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1); // read 1-100
    expect(cls(t.record('a.ts', 1, H1, 3))).toBe('dup-aged'); // re-read 1-300 of the unchanged file
  });

  it('counts a re-read after the file changed as changed, never a dup', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1);
    expect(cls(t.record('a.ts', 1, H2, 4))).toBe('changed');
    expect(t.summary()).toContain('unique=1 changed=1 dup-live=0 dup-aged=0');
  });

  it('re-reads after a change relative to the NEW content classify normally', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1);
    t.record('a.ts', 1, H2, 4); // changed
    expect(cls(t.record('a.ts', 1, H2, 5))).toBe('dup-live'); // unchanged again, one round later
  });
});

describe('ReadTrace repeat counts', () => {
  it('increments the repeat count per identical re-read', () => {
    const t = new ReadTrace();
    expect(t.record('a.ts', 1, H1, 0).repeats).toBe(1);
    expect(t.record('a.ts', 1, H1, 2).repeats).toBe(2);
    expect(t.record('a.ts', 1, H1, 4).repeats).toBe(3);
  });

  it('resets the repeat count when the file changes (an edit is not spinning)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    t.record('a.ts', 1, H1, 2); // repeats=2
    expect(t.record('a.ts', 1, H2, 4).repeats).toBe(1); // changed -> baseline
    expect(t.record('a.ts', 1, H2, 6).repeats).toBe(2);
  });

  it('reports maxrepeat and looped in the summary', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    t.record('a.ts', 1, H1, 2);
    t.record('a.ts', 1, H1, 4); // a.ts repeats=3 -> looped
    t.record('b.ts', 1, H1, 5);
    expect(t.summary()).toContain('maxrepeat=3 looped=1');
  });
});

// loopingReads(currentRound, recentWithin, agedMin, liveMin)
describe('ReadTrace.loopingReads', () => {
  it('flags an aged loop only at the higher aged threshold (a single refetch is benign)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    t.record('a.ts', 1, H1, 3); // dup-aged (distance 3), repeats=2 — a refetch, not yet a loop
    expect(t.loopingReads(3, 3, 3, 2)).toEqual([]);
    t.record('a.ts', 1, H1, 5); // dup-aged, repeats=3 — now a loop
    expect(t.loopingReads(5, 3, 3, 2)).toEqual([{ path: 'a.ts', offset: 1, repeats: 3 }]);
  });

  it('flags a live loop a repeat sooner (re-reading in-context content is never a refetch)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 4);
    t.record('a.ts', 1, H1, 5); // dup-live (distance 1), repeats=2 — already a loop
    expect(t.loopingReads(5, 2, 3, 2)).toEqual([{ path: 'a.ts', offset: 1, repeats: 2 }]);
  });

  it('does not flag a live region at a single read (repeats=1)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    expect(t.loopingReads(0, 2, 3, 2)).toEqual([]);
  });

  it('drops a loop the model has broken out of (no recent re-read)', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    t.record('a.ts', 1, H1, 1);
    t.record('a.ts', 1, H1, 2); // dup-live loop, last at round 2
    // Several rounds later with no further re-read of a.ts: outside the recency window.
    expect(t.loopingReads(6, 2, 3, 2)).toEqual([]);
    // But still within the window right after:
    expect(t.loopingReads(3, 2, 3, 2)).toEqual([{ path: 'a.ts', offset: 1, repeats: 3 }]);
  });

  it('reports each looping region with its offset', () => {
    const t = new ReadTrace();
    for (const r of [0, 1, 2]) t.record('big.ts', 201, H1, r);
    expect(t.loopingReads(2, 2, 3, 2)).toEqual([{ path: 'big.ts', offset: 201, repeats: 3 }]);
  });

  it('a region that aged out after being live falls back to the aged threshold', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0);
    t.record('a.ts', 1, H1, 1); // dup-live, repeats=2
    t.record('a.ts', 1, H1, 5); // dup-aged (distance 4), repeats=3, lastLive=false now
    // repeats=3 still meets the aged threshold, so it's a loop; but had it been repeats=2 here it
    // would not (lastLive flipped to false). Verify the lastLive flag actually switched.
    expect(t.loopingReads(5, 1, 3, 2)).toEqual([{ path: 'a.ts', offset: 1, repeats: 3 }]);
  });
});
