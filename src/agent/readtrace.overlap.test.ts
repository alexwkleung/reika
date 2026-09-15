import { describe, expect, it } from 'vitest';
import { FILE_OVERLAP_DEPTH, ReadTrace } from './readtrace.js';

// #341: the region key is (path, offset), so N distinct slices of one unchanged file never read as
// a loop. The per-file coverage depth catches that shape — and only that shape: a line fetched a
// fourth time is a loop; tiling a capped read once is not.

const H = 'hash-same';
const files = (t: ReadTrace, round: number) =>
  t.loopingReads(round, 2, 3, 2).map(l => `${l.path}${l.offset > 1 ? `:${l.offset}` : ''}`);

describe('ReadTrace per-file coverage depth (#341)', () => {
  it('flags a line fetched a fourth time by reads at distinct offsets', () => {
    const t = new ReadTrace();
    t.record('src/tools/bash.ts', 1, H, 1, 300);
    t.record('src/tools/bash.ts', 21, H, 6, 28); // 21-48 depth 2
    t.record('src/tools/bash.ts', 15, H, 13, 120); // 21-48 depth 3
    expect(files(t, 13)).toEqual([]);
    t.record('src/tools/bash.ts', 49, H, 14, 62); // 49-110 depth 3
    expect(files(t, 14)).toEqual([]);
    t.record('src/tools/bash.ts', 30, H, 15, 28); // 30-48 depth 4
    expect(files(t, 15)).toEqual(['src/tools/bash.ts']);
    expect(t.summary()).toContain('overlapped=1');
  });

  // The un-delegated #335 baseline, verbatim: bash.ts 1-300, 21-48, 21-140, 49-110, 21-48. The
  // last is a `narrowed` re-read at offset 21 (window 28 < 120), which never deepens — so this
  // sequence sits at depth 3 and is left to the region rule. Deliberately conservative: the cost
  // of a false positive here is inspection withdrawn on a model recovering correctly.
  it('leaves the baseline bash.ts sequence alone: its fourth fetch is a sanctioned narrowing', () => {
    const t = new ReadTrace();
    t.record('src/tools/bash.ts', 1, H, 1, 300);
    t.record('src/tools/bash.ts', 21, H, 6, 28);
    t.record('src/tools/bash.ts', 21, H, 13, 120);
    t.record('src/tools/bash.ts', 49, H, 14, 62);
    t.record('src/tools/bash.ts', 21, H, 15, 28);
    expect(files(t, 15)).toEqual([]);
  });

  // The #184 narrowing descent at one offset: 300 → 70 → 35 → 18. Depth 4 by construction if
  // narrowings counted; they don't.
  it('never deepens on the narrowing descent the omission marker asks for', () => {
    const t = new ReadTrace();
    t.record('AGENTS.md', 1, H, 0, 300);
    t.record('AGENTS.md', 44, H, 1, 70);
    t.record('AGENTS.md', 44, H, 2, 35);
    t.record('AGENTS.md', 44, H, 3, 18);
    expect(files(t, 3)).toEqual([]);
  });

  // The #273 arm-2 subagent: types.ts in nested slices, all `unique`/`narrowed` to the region key.
  it('flags the nested-slice spiral', () => {
    const t = new ReadTrace();
    const reads: Array<[number, number, number]> = [
      [1, 300, 0],
      [156, 145, 3], // 156-300
      [330, 50, 3],
      [156, 30, 4], // 156-185 → depth 3
      [200, 100, 4], // 200-299
      [219, 46, 5], // 219-264 → depth 4
    ];
    for (const [off, lim, r] of reads) t.record('src/types.ts', off, H, r, lim);
    expect(files(t, 5)).toEqual(['src/types.ts']);
  });

  // The #343 first run, verbatim: a 244-line read was capped (middle hidden), the model re-read
  // it in four 60-line chunks that arrived whole. The overlap-count version of this rule withdrew
  // inspection on it. Every line is fetched at most three times — never a loop.
  it('never flags a capped read tiled once in whole-arriving chunks', () => {
    const t = new ReadTrace();
    t.record('src/tools/_spill.ts', 1, H, 0, 244);
    t.record('src/tools/_spill.ts', 10, H, 1, 200); // 10-209, still capped
    t.record('src/tools/_spill.ts', 1, H, 3, 60);
    t.record('src/tools/_spill.ts', 61, H, 4, 60);
    t.record('src/tools/_spill.ts', 121, H, 5, 60);
    t.record('src/tools/_spill.ts', 181, H, 6, 64);
    for (const r of [3, 4, 5, 6]) expect(files(t, r)).toEqual([]);
    expect(t.summary()).toContain('overlapped=0');
  });

  it('is honest about a large file paged in many disjoint chunks', () => {
    const t = new ReadTrace();
    for (let i = 0; i < 12; i++) t.record('src/agent/loop.ts', 1 + i * 300, H, i, 300);
    expect(files(t, 11)).toEqual([]);
  });

  it('resets when the file changed: re-reading an edited file is a refetch, not a loop', () => {
    // Three stacked reads, an edit, three more: depth 3 then 3. Unchanged, it would be 6.
    const stack = (t: ReadTrace, hash: string, from: number) => {
      t.record('a.ts', 1, hash, from, 100);
      t.record('a.ts', 10, hash, from + 1, 50);
      t.record('a.ts', 20, hash, from + 2, 20);
    };
    const edited = new ReadTrace();
    stack(edited, 'h1', 0);
    stack(edited, 'h2', 3);
    expect(files(edited, 5)).toEqual([]);
    const unchanged = new ReadTrace();
    stack(unchanged, 'h1', 0);
    stack(unchanged, 'h1', 3);
    expect(files(unchanged, 5)).toEqual(['a.ts']);
  });

  // Distinct offsets so these exercise the depth rule, not the region rule: reads at 1, 2, 3, 4
  // with a 20-line window stack to depth 4 on lines 4-20.
  const stackTo = (t: ReadTrace, depth: number) => {
    for (let r = 0; r < depth; r++) t.record('a.ts', 1 + r, H, r, 20);
  };

  it('goes quiet once the model has moved on (recency gate)', () => {
    const t = new ReadTrace();
    stackTo(t, FILE_OVERLAP_DEPTH);
    expect(files(t, FILE_OVERLAP_DEPTH - 1)).toEqual(['a.ts']);
    expect(files(t, FILE_OVERLAP_DEPTH + 2)).toEqual([]);
  });

  it('stays up while the model keeps reading at the looping depth', () => {
    const t = new ReadTrace();
    stackTo(t, FILE_OVERLAP_DEPTH);
    t.record('a.ts', 10, H, 7, 5); // no deeper, still inside the stack
    expect(files(t, 8)).toEqual(['a.ts']);
  });

  it('does not list a file twice when a region repeat already names it', () => {
    const t = new ReadTrace();
    for (const r of [0, 2, 4, 6]) t.record('a.ts', 1, H, r, 100);
    const out = t.loopingReads(6, 2, 3, 2);
    expect(out.filter(l => l.path === 'a.ts')).toHaveLength(1);
  });
});
