import { describe, expect, it } from 'vitest';
import { formatContext, formatCache, formatPr, packChips, type Chip } from './Status.js';
import { contextFill, formatShrink, kFormat } from './format.js';

describe('kFormat', () => {
  it('shows raw numbers below 1k', () => {
    expect(kFormat(0)).toBe('0');
    expect(kFormat(42)).toBe('42');
    expect(kFormat(999)).toBe('999');
  });

  it('shows one decimal in k for 1k–9.9k', () => {
    expect(kFormat(1000)).toBe('1.0k');
    expect(kFormat(1234)).toBe('1.2k');
    expect(kFormat(9876)).toBe('9.9k');
  });

  it('rounds to whole k for 10k–999k', () => {
    expect(kFormat(10_000)).toBe('10k');
    expect(kFormat(12_345)).toBe('12k');
    expect(kFormat(125_500)).toBe('126k');
    expect(kFormat(999_000)).toBe('999k');
  });

  it('shows one decimal in M for 1M–9.9M', () => {
    expect(kFormat(1_000_000)).toBe('1.0M');
    expect(kFormat(1_250_900)).toBe('1.3M');
    expect(kFormat(9_876_543)).toBe('9.9M');
  });

  it('rounds to whole M for 10M–999M', () => {
    expect(kFormat(10_000_000)).toBe('10M');
    expect(kFormat(12_345_678)).toBe('12M');
    expect(kFormat(999_000_000)).toBe('999M');
  });

  it('shows one decimal in B for 1B–9.9B', () => {
    expect(kFormat(1_000_000_000)).toBe('1.0B');
    expect(kFormat(2_500_000_000)).toBe('2.5B');
    expect(kFormat(9_876_543_210)).toBe('9.9B');
  });

  it('rounds to whole B for 10B+', () => {
    expect(kFormat(10_000_000_000)).toBe('10B');
    expect(kFormat(123_456_789_012)).toBe('123B');
  });

  it('does not produce the old broken 1250.9k format', () => {
    // Regression test: previously kFormat(1_250_900) returned "1250.9k"
    expect(kFormat(1_250_900)).not.toContain('1250');
    expect(kFormat(1_250_900)).toMatch(/M$/);
  });

  it('does not produce the 1000M cliff at the M→B boundary', () => {
    // Without B handling, kFormat(1_000_000_000) would have produced "1000M"
    expect(kFormat(1_000_000_000)).not.toContain('1000M');
    expect(kFormat(1_000_000_000)).toMatch(/B$/);
  });
});

describe('contextFill', () => {
  it('returns the used fraction when both operands are known', () => {
    expect(contextFill(32_000, 128_000)).toBeCloseTo(0.25);
  });

  it('returns null when either operand is missing or zero', () => {
    expect(contextFill(undefined, 128_000)).toBeNull();
    expect(contextFill(0, 128_000)).toBeNull();
    expect(contextFill(32_000, undefined)).toBeNull();
  });
});

describe('formatContext', () => {
  it('shows tokens, window, and percent when the window is known', () => {
    expect(formatContext(45_000, 128_000)).toBe('ctx 45k/128k (35%)');
  });

  it('measures the percent against the usable ceiling when it is known, keeping the raw ratio', () => {
    // 24k window, 6144 reserve: compactThreshold ≈ 16,070. A prompt at that size is at the shed
    // trigger — 100% — even though it fills only 67% of the raw window.
    expect(formatContext(16_070, 24_000, 16_070)).toBe('ctx 16k/24k (100% of 16k)');
    // Just after a shed (the 0.7 low watermark) reads 70%, not 47%.
    expect(formatContext(11_249, 24_000, 16_070)).toBe('ctx 11k/24k (70% of 16k)');
  });

  it('can exceed 100% — the request that trips the shed measured above the ceiling', () => {
    expect(formatContext(17_000, 24_000, 16_070)).toBe('ctx 17k/24k (106% of 16k)');
  });

  it('shows only the size when the window is unknown', () => {
    expect(formatContext(45_000)).toBe('ctx 45k');
  });

  it('renders nothing before any context exists', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0, 128_000)).toBe('');
  });
});

describe('formatShrink', () => {
  it('pluralizes each count and omits zeros', () => {
    expect(formatShrink(3, 1)).toBe('3 sheds · 1 fold');
    expect(formatShrink(1, 2)).toBe('1 shed · 2 folds');
    expect(formatShrink(5, 0)).toBe('5 sheds');
    expect(formatShrink(0, 1)).toBe('1 fold');
    expect(formatShrink(0, 0)).toBe('');
  });
});

describe('formatPr', () => {
  it('shows the PR the branch is attached to', () => {
    expect(formatPr(99)).toBe('PR: #99');
  });

  it('renders nothing when the branch has no PR', () => {
    expect(formatPr(null)).toBe('');
    expect(formatPr(undefined)).toBe('');
    expect(formatPr(0)).toBe('');
  });
});

describe('formatCache', () => {
  it('shows the cached share of the last prompt and its size', () => {
    expect(formatCache(40_000, 50_000)).toBe('80% cached (40k)');
  });

  it('drops the count on a cold call, where it would only repeat the percent', () => {
    expect(formatCache(0, 50_000)).toBe('0% cached');
  });

  it('keeps the count when a small hit rounds to 0%', () => {
    expect(formatCache(200, 50_000)).toBe('0% cached (200)');
  });

  it('renders nothing when the provider does not report cache hits', () => {
    expect(formatCache(undefined, 50_000)).toBe('');
  });

  it('renders nothing when there is no prompt to compare against', () => {
    expect(formatCache(40_000, 0)).toBe('');
  });
});

describe('packChips', () => {
  const chip = (text: string): Chip => [{ text, color: 'x' }];
  const texts = (lines: Chip[][]) => lines.map(l => l.map(c => c.map(s => s.text).join('')));

  it('packs chips first-fit, paying for the separator between them', () => {
    // 'aaaa · bbbb' is 11 columns; a third 4-wide chip needs 18.
    expect(texts(packChips([chip('aaaa'), chip('bbbb'), chip('cccc')], 12))).toEqual([
      ['aaaa', 'bbbb'],
      ['cccc'],
    ]);
    expect(texts(packChips([chip('aaaa'), chip('bbbb'), chip('cccc')], 18))).toEqual([
      ['aaaa', 'bbbb', 'cccc'],
    ]);
  });

  it('never splits a chip — one wider than the line gets a line of its own', () => {
    expect(texts(packChips([chip('ab'), chip('a much longer chip'), chip('cd')], 10))).toEqual([
      ['ab'],
      ['a much longer chip'],
      ['cd'],
    ]);
  });

  it('measures a multi-segment chip as one unit, in columns', () => {
    // 'agent' + ' (hint)' is 12 wide, the token chip 11: together with the separator, 26.
    const multi: Chip = [
      { text: 'agent', color: 'a' },
      { text: ' (hint)', color: 'b' },
    ];
    expect(texts(packChips([multi, chip('123k↑ 4.6k↓')], 26))).toEqual([
      ['agent (hint)', '123k↑ 4.6k↓'],
    ]);
    expect(texts(packChips([multi, chip('123k↑ 4.6k↓')], 25))).toEqual([
      ['agent (hint)'],
      ['123k↑ 4.6k↓'],
    ]);
  });
});
