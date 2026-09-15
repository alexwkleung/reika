import { describe, expect, it } from 'vitest';
import { FILE_OVERLAP_REPEATS, ReadTrace } from './readtrace.js';

// #341: the region key is (path, offset), so N distinct slices of one unchanged file never read as
// a loop. The per-file overlap count catches that shape — and only that shape.

const H = 'hash-same';
const files = (t: ReadTrace, round: number) =>
  t.loopingReads(round, 2, 3, 2).map(l => `${l.path}${l.offset > 1 ? `:${l.offset}` : ''}`);

describe('ReadTrace per-file overlap loop (#341)', () => {
  // The un-delegated #335 baseline, verbatim from its log: bash.ts 1-300, 21-48, 21-140, 49-110,
  // 21-48 — five reads, every one `unique` or `narrowed` to the region key.
  it('flags the baseline bash.ts sequence on its fourth overlapping read', () => {
    const t = new ReadTrace();
    t.record('src/tools/bash.ts', 1, H, 1, 300);
    t.record('src/tools/bash.ts', 21, H, 6, 28); // overlap 1 (the omission marker's own remedy)
    t.record('src/tools/bash.ts', 21, H, 13, 120); // overlap 2
    expect(files(t, 13)).toEqual([]);
    t.record('src/tools/bash.ts', 49, H, 14, 62); // overlap 3
    expect(files(t, 14)).toEqual([]);
    t.record('src/tools/bash.ts', 21, H, 15, 28); // overlap 4
    expect(files(t, 15)).toEqual(['src/tools/bash.ts']);
    expect(t.summary()).toContain('overlapped=1');
  });

  // _danger.ts (735 lines): three honest forward pages, then the spiral.
  it('never counts forward paging, then flags the re-slicing that follows it', () => {
    const t = new ReadTrace();
    t.record('src/tools/_danger.ts', 1, H, 2, 300);
    t.record('src/tools/_danger.ts', 301, H, 3, 300);
    t.record('src/tools/_danger.ts', 601, H, 4, 135);
    expect(files(t, 4)).toEqual([]);
    t.record('src/tools/_danger.ts', 690, H, 7, 46); // overlap 1
    t.record('src/tools/_danger.ts', 690, H, 14, 46); // overlap 2 (also a region dup, but aged)
    t.record('src/tools/_danger.ts', 1, H, 15, 40); // overlap 3
    expect(files(t, 15)).toEqual([]);
    t.record('src/tools/_danger.ts', 690, H, 16, 46); // overlap 4 — and the region's 3rd repeat
    // Named once: the region rule fires at 3 dup-aged repeats and the file-level entry defers to
    // it (one line in the ledger, either way the ladder engages).
    const out = t.loopingReads(16, 2, 3, 2);
    expect(out.filter(l => l.path === 'src/tools/_danger.ts')).toHaveLength(1);
  });

  it('is honest about a large file paged in many disjoint chunks', () => {
    const t = new ReadTrace();
    for (let i = 0; i < 12; i++) t.record('src/agent/loop.ts', 1 + i * 300, H, i, 300);
    expect(files(t, 11)).toEqual([]);
    expect(t.summary()).toContain('overlapped=0');
  });

  it('resets when the file changed: re-reading an edited file is a refetch, not a loop', () => {
    const t = new ReadTrace();
    t.record('a.ts', 1, 'h1', 0, 100);
    t.record('a.ts', 1, 'h1', 1, 50);
    t.record('a.ts', 20, 'h1', 2, 50);
    t.record('a.ts', 1, 'h2', 3, 100); // edited
    t.record('a.ts', 1, 'h2', 4, 50);
    t.record('a.ts', 20, 'h2', 5, 50);
    expect(files(t, 5)).toEqual([]);
  });

  it('goes quiet once the model has moved on (recency gate)', () => {
    const t = new ReadTrace();
    for (let r = 0; r <= FILE_OVERLAP_REPEATS; r++) t.record('a.ts', 1, H, r, 10 + r);
    expect(files(t, FILE_OVERLAP_REPEATS)).toEqual(['a.ts']);
    expect(files(t, FILE_OVERLAP_REPEATS + 3)).toEqual([]);
  });

  it('does not list a file twice when a region repeat already names it', () => {
    const t = new ReadTrace();
    // Same region four times, aged: the region rule fires at 3 repeats; overlaps reach 4 too.
    for (let r = 0; r < 5; r += 2) t.record('a.ts', 1, H, r, 100);
    t.record('a.ts', 1, H, 6, 100);
    t.record('a.ts', 1, H, 8, 100);
    const out = t.loopingReads(8, 2, 3, 2);
    expect(out.filter(l => l.path === 'a.ts')).toHaveLength(1);
    expect(out[0].offset).toBe(1);
  });
});
