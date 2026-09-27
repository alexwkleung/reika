import { describe, expect, it } from 'vitest';
import type { Config } from '../types.js';
import { GenReserve, resolveGenReserve, withGenReserve } from './genreserve.js';

type ReserveConfig = Pick<Config, 'minGenTokens' | 'minGenAdaptive' | 'contextWindow'>;
const adaptive = (contextWindow?: number): ReserveConfig => ({
  minGenTokens: 2048,
  minGenAdaptive: true,
  contextWindow,
});

function observed(...tokens: number[]): GenReserve {
  const r = new GenReserve();
  for (const t of tokens) r.observe(t, 'stop');
  return r;
}

describe('resolveGenReserve', () => {
  it('stays at the default until a round needs more', () => {
    expect(resolveGenReserve(adaptive(32_000), new GenReserve())).toEqual({
      tokens: 2048,
      source: 'default',
    });
    expect(resolveGenReserve(adaptive(32_000), observed(400, 900, 1200))).toEqual({
      tokens: 2048,
      source: 'default',
    });
  });

  it('learns a thinking model up from its big rounds, with headroom, in steps', () => {
    // 5000 × 1.25 = 6250 → rounded up to 6400.
    expect(resolveGenReserve(adaptive(32_000), observed(600, 5000))).toEqual({
      tokens: 6400,
      source: 'learned',
    });
  });

  it('covers the p90 round, not the average — and one outlier in ten is not the p90', () => {
    const recurring = observed(500, 500, 500, 500, 500, 500, 500, 500, 4000, 4000);
    expect(resolveGenReserve(adaptive(64_000), recurring).tokens).toBe(5120);
    const once = observed(500, 500, 500, 500, 500, 500, 500, 500, 500, 4000);
    expect(resolveGenReserve(adaptive(64_000), once).tokens).toBe(2048);
  });

  it('caps at a quarter of the window, and the floor wins on a tiny one', () => {
    expect(resolveGenReserve(adaptive(16_000), observed(12_000)).tokens).toBe(4000);
    expect(resolveGenReserve(adaptive(8000), observed(12_000))).toEqual({
      tokens: 2048,
      source: 'default',
    });
  });

  it('ignores rounds that did not finish on their own', () => {
    const r = new GenReserve();
    r.observe(9000, 'length');
    r.observe(9000, undefined);
    r.observe(undefined, 'stop');
    expect(resolveGenReserve(adaptive(32_000), r).source).toBe('default');
    r.observe(9000, 'tool_calls');
    expect(resolveGenReserve(adaptive(64_000), r).source).toBe('learned');
  });

  it('counts a healthy ceiling cut as demand', () => {
    const r = new GenReserve();
    r.observeCeilingCut(8000);
    expect(resolveGenReserve(adaptive(64_000), r)).toEqual({ tokens: 10_240, source: 'learned' });
  });

  it('forgets rounds past its window, so it can come back down', () => {
    const r = observed(8000);
    for (let i = 0; i < 16; i++) r.observe(500, 'stop');
    expect(resolveGenReserve(adaptive(64_000), r).tokens).toBe(2048);
  });

  it('an explicit reserve is pinned, learned or not', () => {
    const pinned = { minGenTokens: 1024, contextWindow: 32_000 };
    expect(resolveGenReserve(pinned, observed(8000))).toEqual({ tokens: 1024, source: 'pinned' });
  });
});

describe('withGenReserve', () => {
  it('returns the same config when nothing was learned', () => {
    const cfg = adaptive(32_000) as Config;
    expect(withGenReserve(cfg, new GenReserve())).toBe(cfg);
    expect(withGenReserve(cfg, observed(5000)).minGenTokens).toBe(6400);
  });
});
