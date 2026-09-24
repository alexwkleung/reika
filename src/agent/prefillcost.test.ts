import { describe, expect, it } from 'vitest';
import { PrefillRate, formatPrefillCost, reprocessedTokens, sampleTokens } from './prefillcost.js';
import type { PrefixDivergence } from './prefixtrace.js';

const div = (stableChars: number, totalChars: number): PrefixDivergence => ({
  cause: 'mid-history',
  stableMessages: 1,
  totalMessages: 2,
  stableChars,
  totalChars,
});

describe('reprocessedTokens', () => {
  it('scales the prompt-token count by the unstable char fraction', () => {
    expect(reprocessedTokens(div(10020, 32710), 10000)).toBe(6937);
  });

  it('reports the whole prompt when nothing was stable', () => {
    expect(reprocessedTokens(div(0, 32710), 8000)).toBe(8000);
  });

  it('reports nothing when the request was byte-identical', () => {
    expect(reprocessedTokens(div(32710, 32710), 8000)).toBe(0);
  });

  // A pure append still reprocesses its new tail — that is a real prefill cost, not a free round.
  it('counts an append-only tail', () => {
    expect(reprocessedTokens(div(32000, 32710), 8000)).toBe(174);
  });

  it('stays at zero for a degenerate estimate', () => {
    expect(reprocessedTokens(div(0, 0), 0)).toBe(0);
    expect(reprocessedTokens(div(0, 0), 500)).toBe(500);
  });
});

describe('sampleTokens', () => {
  it('prefers the provider cache accounting over the char estimate', () => {
    expect(
      sampleTokens({ promptTokens: 9000, completionTokens: 20, cachedTokens: 6000 }, 4000),
    ).toBe(3000);
  });

  it('falls back to the estimate when the provider reports no cache hits', () => {
    expect(sampleTokens({ promptTokens: 9000, completionTokens: 20 }, 4000)).toBe(4000);
    expect(sampleTokens(undefined, 4000)).toBe(4000);
  });

  it('never goes negative on inconsistent provider accounting', () => {
    expect(sampleTokens({ promptTokens: 100, completionTokens: 5, cachedTokens: 500 }, 4000)).toBe(
      0,
    );
  });
});

describe('PrefillRate', () => {
  it('learns a rate from an observed prefill', () => {
    const r = new PrefillRate();
    expect(r.get()).toBeUndefined();
    expect(r.observe(8952, 390_000)).toBeCloseTo(22.95, 1);
    expect(r.estimateSeconds(8952)).toBeCloseTo(390, 0);
  });

  // TTFT is prefill PLUS a fixed per-request overhead; a tiny append behind a slow handshake
  // would teach a wildly low rate, so small samples are rejected outright.
  it('rejects samples too small to separate prefill from per-request overhead', () => {
    const r = new PrefillRate();
    expect(r.observe(40, 2000)).toBeUndefined();
    expect(r.observe(8952, 10)).toBeUndefined();
    expect(r.get()).toBeUndefined();
  });

  it('rejects a rate outside the plausible band', () => {
    const r = new PrefillRate();
    expect(r.observe(600, 900_000)).toBeUndefined();
    expect(r.get()).toBeUndefined();
  });

  it('smooths rather than jumping to the newest sample', () => {
    const r = new PrefillRate();
    r.observe(1000, 100_000); // 10 tok/s
    const after = r.observe(1000, 10_000); // 100 tok/s
    expect(after).toBeCloseTo(37, 0);
  });

  it('seeds from a prior turn so round 0 can already price itself', () => {
    expect(new PrefillRate(23).get()).toBe(23);
  });

  it('ignores an implausible seed', () => {
    expect(new PrefillRate(0).get()).toBeUndefined();
    expect(new PrefillRate(-5).get()).toBeUndefined();
    expect(new PrefillRate(1e9).get()).toBeUndefined();
  });

  it('has no estimate until it has a rate', () => {
    expect(new PrefillRate().estimateSeconds(8952)).toBeUndefined();
  });
});

describe('formatPrefillCost', () => {
  it('reads as the most expensive event in the session when it is one', () => {
    expect(formatPrefillCost(8952, 22.95)).toBe('reprocess=8952tok est=390s rate=23tok/s');
  });

  // `?` rather than an omitted field: a missing estimate must not read as a cheap round.
  it('marks an unlearned rate explicitly', () => {
    expect(formatPrefillCost(8952)).toBe('reprocess=8952tok est=? rate=?');
  });

  it('keeps sub-10 values readable instead of rounding them to 0', () => {
    expect(formatPrefillCost(174, 22.95)).toBe('reprocess=174tok est=7.6s rate=23tok/s');
    expect(formatPrefillCost(174, 2.5)).toBe('reprocess=174tok est=70s rate=2.5tok/s');
  });

  // A turn's first request has no measured baseline: the full prompt is a ceiling on what the
  // engine re-processed (it usually still holds the previous turn's prefix), so the line says so.
  it('marks an unmeasured round as an upper bound', () => {
    expect(formatPrefillCost(8952, 22.95, true)).toBe(
      'reprocess\u22648952tok est\u2264390s rate=23tok/s',
    );
    expect(formatPrefillCost(8952, undefined, true)).toBe(
      'reprocess\u22648952tok est\u2264? rate=?',
    );
  });

  it('stays on one line', () => {
    expect(formatPrefillCost(8952, 22.95)).not.toContain('\n');
  });
});
