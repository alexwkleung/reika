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

describe('withLiveUsage (#925)', () => {
  const total = { promptTokens: 100, completionTokens: 20, cachedTokens: 5 };

  it('returns the total itself when nothing is in flight', () => {
    expect(withLiveUsage(total, undefined)).toBe(total);
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
