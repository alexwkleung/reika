import { describe, expect, it } from 'vitest';
import { allocateLiveRows, displayRows, fitTail, lastCall, tailText } from './Scrollback.js';

describe('tailText', () => {
  it('returns text unchanged when within the line budget', () => {
    const t = 'a\nb\nc';
    expect(tailText(t, 5)).toEqual({ text: t, truncated: false });
  });

  it('keeps only the last maxLines rows and flags truncation', () => {
    const t = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const out = tailText(t, 2);
    expect(out.text).toBe('l4\nl5');
    expect(out.truncated).toBe(true);
  });

  it('applies a character backstop for long unwrapped lines', () => {
    const t = 'x'.repeat(10_000); // single line, no newlines
    const out = tailText(t, 3, 100);
    expect(out.text.length).toBe(100);
    expect(out.truncated).toBe(true);
  });

  it('never exceeds the budget regardless of input shape', () => {
    const t = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const out = tailText(t, 10);
    expect(out.text.split('\n').length).toBeLessThanOrEqual(10);
    expect(out.truncated).toBe(true);
  });
});

describe('displayRows', () => {
  it('counts wrapped rows, not logical lines, so a long line costs many rows', () => {
    const t = 'w '.repeat(15).trim(); // "w w w ..." → 29 chars, 3 rows at width 10
    expect(displayRows(t, 10)).toHaveLength(3);
  });
});

describe('fitTail', () => {
  it('shows every row when they fit', () => {
    expect(fitTail({ rows: ['a', 'b', 'c'], cut: false }, 5)).toEqual({
      text: 'a\nb\nc',
      marker: false,
    });
  });

  it('counts the marker inside the allowance', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const tail = fitTail({ rows, cut: false }, 8);
    // The whole point: the live frame can never be taller than its share, which is
    // what keeps Ink from crossing `outputHeight >= rows` and clearing scrollback.
    expect(tail.marker).toBe(true);
    expect(tail.text.split('\n')).toEqual(rows.slice(-7));
  });

  it('marks a pre-trimmed block even when its rows fit', () => {
    expect(fitTail({ rows: ['a'], cut: true }, 5).marker).toBe(true);
  });
});

describe('allocateLiveRows', () => {
  it('gives a lone block what it needs, up to the pool', () => {
    expect(allocateLiveRows([4], 20)).toEqual([4]);
    expect(allocateLiveRows([50], 20)).toEqual([20]);
  });

  // The regression: an even split dropped a 20-row reasoning tail to 10 the moment a 1-row
  // answer began, so the frame shrank and the input jumped up mid-turn.
  it('takes rows from the older block only as the newer one grows', () => {
    expect(allocateLiveRows([50, 1], 20)).toEqual([19, 1]);
    expect(allocateLiveRows([50, 6], 20)).toEqual([14, 6]);
  });

  it('never grows past the pool, and leaves each older block its floor', () => {
    expect(allocateLiveRows([50, 50], 20)).toEqual([3, 17]);
    expect(allocateLiveRows([50, 50, 50], 20)).toEqual([3, 3, 14]);
  });

  it('keeps the total from shrinking as a new block streams in', () => {
    let prev = 0;
    for (let answer = 1; answer <= 40; answer++) {
      const total = allocateLiveRows([50, answer], 20).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
  });
});

describe('lastCall', () => {
  const counted = () => {
    let calls = 0;
    const run = lastCall((text: string, width: number) => {
      calls++;
      return `${text}@${width}`;
    });
    return { run, calls: () => calls };
  };

  it('computes once while every argument is identical', () => {
    const { run, calls } = counted();
    expect(run('hello', 80)).toBe('hello@80');
    expect(run('hello', 80)).toBe('hello@80');
    expect(run('hello', 80)).toBe('hello@80');
    expect(calls()).toBe(1);
  });

  // The invalidation rule the live blocks depend on: a block whose text did not change but whose
  // width did (a resize) has to be rebuilt, or it keeps rows wrapped for the old terminal.
  it('recomputes when any argument changes, width as much as text', () => {
    const { run, calls } = counted();
    run('hello', 80);
    run('hello', 100);
    expect(calls()).toBe(2);
    run('hello!', 100);
    expect(calls()).toBe(3);
    run('hello!', 100);
    expect(calls()).toBe(3);
  });

  // An empty string and a same-length one are different arguments; identity is what is compared.
  it('treats an equal-length but different string as a miss', () => {
    const { run, calls } = counted();
    run('abc', 80);
    run('xyz', 80);
    expect(calls()).toBe(2);
  });

  // One entry, so the cache cannot grow with the session — and alternating between two inputs
  // thrashes rather than accumulating. Both are the intended shape: the live region computes each
  // block in turn, and only the block that is streaming changes between renders.
  it('holds one entry: alternating inputs recompute every time', () => {
    const { run, calls } = counted();
    run('a', 10);
    run('b', 10);
    run('a', 10);
    run('b', 10);
    expect(calls()).toBe(4);
  });

  // The live blocks pass `() => chalk.level` here: the paint is baked into the rows (the prose
  // marker, inline code, a highlighted fence), and the level is not an argument. Unchanged
  // ambient value → a hit; a changed one → a miss, so a block cannot keep the paint it was built
  // under after the level moves.
  it('recomputes when the ambient input changes, and not otherwise', () => {
    let calls = 0;
    let level = 0;
    const run = lastCall(
      (text: string) => {
        calls++;
        return `${level}:${text}`;
      },
      () => level,
    );
    expect(run('a')).toBe('0:a');
    expect(run('a')).toBe('0:a');
    expect(calls).toBe(1);
    level = 3;
    expect(run('a')).toBe('3:a');
    expect(run('a')).toBe('3:a');
    expect(calls).toBe(2);
  });
});
