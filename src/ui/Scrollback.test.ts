import { describe, expect, it } from 'vitest';
import { tailDisplay, tailText } from './Scrollback.js';

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

describe('tailDisplay', () => {
  it('returns text unchanged when within the row budget', () => {
    const t = 'a\nb\nc';
    expect(tailDisplay(t, 5, 80)).toEqual({ text: t, truncated: false });
  });

  it('counts wrapped rows, not logical lines, so a long line costs many rows', () => {
    // One logical line of 30 chars wraps to 3 rows at width 10. tailText would see
    // it as a single line (under budget); tailDisplay must truncate it to 2 rows.
    const t = 'w '.repeat(15).trim(); // "w w w ..." → 29 chars
    const out = tailDisplay(t, 2, 10);
    expect(out.truncated).toBe(true);
    expect(out.text.split('\n').length).toBe(2);
  });

  it('bounds rendered output to at most maxRows display rows', () => {
    const t = Array.from({ length: 200 }, (_, i) => `row ${i} `.repeat(20)).join('\n');
    const out = tailDisplay(t, 8, 40);
    // The whole point: the live frame can never be taller than the budget, which is
    // what keeps Ink from crossing `outputHeight >= rows` and clearing scrollback.
    expect(out.text.split('\n').length).toBeLessThanOrEqual(8);
    expect(out.truncated).toBe(true);
  });
});
