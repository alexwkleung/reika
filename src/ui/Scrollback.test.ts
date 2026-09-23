import { describe, expect, it } from 'vitest';
import { allocateLiveRows, displayRows, fitTail, tailText } from './Scrollback.js';

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
