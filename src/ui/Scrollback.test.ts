import { describe, expect, it } from 'vitest';
import { tailText } from './Scrollback.js';

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
