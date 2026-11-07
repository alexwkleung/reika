import { describe, expect, it } from 'vitest';
import { LiveRound, withLiveUsage, type LiveUsage } from './liveusage.js';

function round(density = 1, clock = { t: 0 }) {
  const reports: LiveUsage[] = [];
  const live = new LiveRound(
    5000,
    density,
    r => reports.push(r),
    () => clock.t,
  );
  return { live, reports, clock };
}

describe('LiveRound (#925)', () => {
  it('reports the prompt as the request goes out, before any output', () => {
    const { reports } = round();
    expect(reports).toEqual([{ promptTokens: 5000, completionTokens: 0 }]);
  });

  it('counts the text, not the deltas, at the given density', () => {
    const { live, reports } = round(2);
    live.add('a'.repeat(40));
    live.add('b'.repeat(40));
    expect(reports.at(-1)?.completionTokens).toBe(40);
  });

  it('prints no rate until the window can carry one', () => {
    const { live, reports, clock } = round();
    live.add('a'.repeat(400));
    clock.t = 100;
    live.add('a'.repeat(400));
    expect(reports.at(-1)?.rate).toBeUndefined();
  });

  it('measures the rate from the first output, not from the request', () => {
    const { live, reports, clock } = round();
    clock.t = 60_000;
    live.add('abcd');
    clock.t = 61_000;
    live.add('a'.repeat(100 * 4));
    expect(reports.at(-1)?.rate).toBeCloseTo(100, 0);
  });
});

describe('LiveRound with engine timings (#925)', () => {
  const timings = { predictedN: 200, predictedMs: 10_000, perSecond: 20 };
  const prompt = { promptN: 300, cacheN: 7000 };

  it("reports the engine's counts and rate as exact", () => {
    const { live, reports } = round();
    live.engine(timings, prompt);
    expect(reports.at(-1)).toEqual({
      promptTokens: 7300,
      completionTokens: 200,
      rate: 20,
      exact: true,
    });
  });

  it('stops estimating once the engine has reported', () => {
    const { live, reports } = round();
    live.add('a'.repeat(4000));
    live.engine(timings, prompt);
    const count = reports.length;
    live.add('a'.repeat(4000));
    expect(reports).toHaveLength(count);
  });

  it('keeps the prompt estimate, and the mark, without both prompt fields', () => {
    const { live, reports } = round();
    live.engine(timings, { promptN: 300 });
    expect(reports.at(-1)).toEqual({ promptTokens: 5000, completionTokens: 200, rate: 20 });
  });

  it('holds back a rate the sample bounds reject', () => {
    const { live, reports } = round();
    live.engine({ predictedN: 5, predictedMs: 100, perSecond: 50 }, prompt);
    expect(reports.at(-1)?.rate).toBeUndefined();
  });
});

describe('withLiveUsage (#925)', () => {
  const total = { promptTokens: 100, completionTokens: 20, cachedTokens: 5 };

  it('returns the total itself when nothing is in flight', () => {
    expect(withLiveUsage(total, undefined)).toBe(total);
  });

  it('leaves an exact report unmarked', () => {
    const live = { promptTokens: 50, completionTokens: 7, exact: true };
    expect(withLiveUsage(total, live).estimated).toBeUndefined();
  });

  it('adds the live round and marks the sum as an estimate', () => {
    expect(withLiveUsage(total, { promptTokens: 50, completionTokens: 7 })).toEqual({
      promptTokens: 150,
      completionTokens: 27,
      cachedTokens: 5,
      estimated: true,
    });
  });
});
