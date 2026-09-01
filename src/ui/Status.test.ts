import { describe, expect, it } from 'vitest';
import { formatContext, formatCache, formatPr } from './Status.js';
import { contextFill, kFormat } from './format.js';

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
    expect(formatContext(45_000, 128_000)).toBe(' · ctx 45k/128k (35%)');
  });

  it('shows only the size when the window is unknown', () => {
    expect(formatContext(45_000)).toBe(' · ctx 45k');
  });

  it('renders nothing before any context exists', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0, 128_000)).toBe('');
  });
});

describe('formatPr', () => {
  it('shows the PR the branch is attached to', () => {
    expect(formatPr(99)).toBe(' · PR: #99');
  });

  it('renders nothing when the branch has no PR', () => {
    expect(formatPr(null)).toBe('');
    expect(formatPr(undefined)).toBe('');
    expect(formatPr(0)).toBe('');
  });
});

describe('formatCache', () => {
  it('shows the cached share of the last prompt', () => {
    expect(formatCache(40_000, 50_000)).toBe(' · cache 80%');
  });

  it('renders nothing when the provider does not report cache hits', () => {
    expect(formatCache(undefined, 50_000)).toBe('');
  });

  it('renders nothing when there is no prompt to compare against', () => {
    expect(formatCache(40_000, 0)).toBe('');
  });
});
