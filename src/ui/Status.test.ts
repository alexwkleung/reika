import { describe, expect, it } from 'vitest';
import { kFormat } from './Status.js';

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
