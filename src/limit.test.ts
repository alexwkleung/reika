import { describe, expect, it } from 'vitest';
import { mapLimit } from './limit.js';

// A task that resolves only when released, so the test controls how many are live at once.
function gate() {
  const pending: Array<() => void> = [];
  return {
    hold: () => new Promise<void>(resolve => pending.push(resolve)),
    release: (n = pending.length) => pending.splice(0, n).forEach(r => r()),
    live: () => pending.length,
  };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('mapLimit', () => {
  it('never runs more than `concurrency` tasks at once and keeps input order', async () => {
    const g = gate();
    let peak = 0;
    const p = mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      peak = Math.max(peak, g.live() + 1);
      await g.hold();
      return n * 10;
    });
    await tick();
    expect(g.live()).toBe(3);
    g.release(2);
    await tick();
    expect(g.live()).toBe(3);
    while (g.live() > 0) {
      g.release();
      await tick();
    }
    expect(await p).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it('runs everything at once when the input is narrower than the limit', async () => {
    const g = gate();
    const p = mapLimit(['a', 'b'], 8, async s => {
      await g.hold();
      return s.toUpperCase();
    });
    await tick();
    expect(g.live()).toBe(2);
    g.release();
    expect(await p).toEqual(['A', 'B']);
  });

  it('propagates a rejection and starts nothing further', async () => {
    const started: number[] = [];
    const g = gate();
    const p = mapLimit([1, 2, 3, 4, 5], 2, async n => {
      started.push(n);
      await g.hold();
      if (n === 1) throw new Error(`boom ${n}`);
      return n;
    });
    await tick();
    g.release();
    await expect(p).rejects.toThrow('boom 1');
    // Task 2 was live alongside 1; 3 may have been pulled by 2's worker before 1 threw, but the
    // failure stops the pull, so 4 and 5 never start.
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
    g.release();
  });

  it('resolves an empty input without calling fn', async () => {
    let calls = 0;
    expect(
      await mapLimit([], 4, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects a non-positive limit up front', async () => {
    await expect(mapLimit([1], 0, async n => n)).rejects.toThrow(RangeError);
  });
});
