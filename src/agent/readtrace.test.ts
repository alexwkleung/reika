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

  it('normalizes a WIDENING read window: same offset, larger limit -> still a dup, not unique', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1, 100); // read 1-100
    // Re-read 1-300 of the unchanged file: a superset, but it re-sends every line already held.
    expect(cls(t.record('a.ts', 1, H1, 3, 300))).toBe('dup-aged');
  });

  it('normalizes a re-read at the same window, whatever the window is', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1, 70);
    expect(cls(t.record('a.ts', 1, H1, 3, 70))).toBe('dup-aged');
  });

  it('keeps the pre-narrowing semantics when the caller passes no limit at all', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 1);
    expect(cls(t.record('a.ts', 1, H1, 3))).toBe('dup-aged');
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

// #184: capPayload tells a model whose output was omitted to "read a narrower line range". That
// recovery holds `offset` fixed and shrinks `limit` — the axis the key normalizes away — so it used
// to land on the same key as the read it was recovering from and confirm a live loop on its second
// step, withdrawing the very tools it needed.
describe('ReadTrace narrowing (a shrinking window is a new request, not a re-read)', () => {
  it('classifies a strictly narrower window at the same offset as narrowed, not a dup', () => {
    const t = new ReadTrace();
    t.record('AGENTS.md', 44, H1, 1, 70);
    expect(cls(t.record('AGENTS.md', 44, H1, 2, 35))).toBe('narrowed');
  });

  it('treats an explicit limit after a default-window read as narrowing', () => {
    const t = new ReadTrace();
    t.record('AGENTS.md', 1, H1, 0, 300); // the tool's default window
    expect(cls(t.record('AGENTS.md', 1, H1, 1, 70))).toBe('narrowed');
  });

  it('does not confirm a loop while the model narrows its way around an omitted payload', () => {
    const t = new ReadTrace();
    // The transcript from #184: full read, then successively smaller windows at one offset.
    t.record('AGENTS.md', 1, H1, 0, 300);
    t.record('AGENTS.md', 44, H1, 1, 70); // omitted -> narrow
    t.record('AGENTS.md', 44, H1, 2, 35); // omitted -> narrow again
    t.record('AGENTS.md', 44, H1, 3, 18); // omitted -> narrow again
    // LOOP_LIVE_REPEATS = 2 in loop.ts; this used to be a confirmed loop by the second narrowing.
    expect(t.loopingReads(3, 2, 3, 2)).toEqual([]);
  });

  it('still catches real spinning: the same narrow window re-read after narrowing', () => {
    const t = new ReadTrace();
    t.record('a.ts', 44, H1, 0, 70);
    expect(cls(t.record('a.ts', 44, H1, 1, 18))).toBe('narrowed');
    // Asking for that same 18 lines again returns bytes it just received — that is the loop.
    expect(cls(t.record('a.ts', 44, H1, 2, 18))).toBe('dup-live');
    expect(t.loopingReads(2, 2, 3, 2)).toEqual([{ path: 'a.ts', offset: 44, repeats: 2 }]);
  });

  it('stops granting the exemption after MAX_NARROWINGS steps at one region', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0, 300);
    expect(cls(t.record('a.ts', 1, H1, 1, 100))).toBe('narrowed'); // 1
    expect(cls(t.record('a.ts', 1, H1, 2, 50))).toBe('narrowed'); // 2
    expect(cls(t.record('a.ts', 1, H1, 3, 20))).toBe('narrowed'); // 3 — budget spent
    // A fourth shrink at the same start line is no longer recovery; it counts as a repeat again.
    expect(cls(t.record('a.ts', 1, H1, 4, 10))).toBe('dup-live');
    expect(t.loopingReads(4, 2, 3, 2)).toEqual([{ path: 'a.ts', offset: 1, repeats: 2 }]);
  });

  it('gives a region a fresh narrowing budget once the file changes', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0, 300);
    t.record('a.ts', 1, H1, 1, 100);
    t.record('a.ts', 1, H1, 2, 50);
    t.record('a.ts', 1, H1, 3, 20); // budget spent against H1
    expect(cls(t.record('a.ts', 1, H2, 4, 300))).toBe('changed');
    expect(cls(t.record('a.ts', 1, H2, 5, 100))).toBe('narrowed');
  });

  it('narrowing restarts the repeat run rather than continuing it', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0, 300);
    expect(t.record('a.ts', 1, H1, 1, 300).repeats).toBe(2); // plain re-read
    expect(t.record('a.ts', 1, H1, 2, 100).repeats).toBe(1); // narrowed -> back to baseline
  });

  it('counts narrowed reads in the summary distribution', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0, 300);
    t.record('a.ts', 1, H1, 1, 100);
    expect(t.summary()).toContain('unique=1 changed=0 dup-live=0 dup-aged=0 narrowed=1');
    expect(t.total()).toBe(2);
  });

  it('does not confuse a narrower window at a DIFFERENT offset with narrowing', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, H1, 0, 300);
    // A different start line is a different region — fresh key, unique, no budget consumed.
    expect(cls(t.record('a.ts', 200, H1, 1, 20))).toBe('unique');
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
