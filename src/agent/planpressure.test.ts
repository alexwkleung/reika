import { describe, expect, it } from 'vitest';
import { planFill, planPressureFor, planPressureLine } from './planpressure.js';

describe('planPressureFor — windowless', () => {
  it('keeps the round-count schedule when there is no window to measure', () => {
    expect(planPressureFor({ round: 0, examined: false })).toBe('none');
    expect(planPressureFor({ round: 1, examined: true })).toBe('soft');
    expect(planPressureFor({ round: 3, examined: true })).toBe('firm');
    expect(planPressureFor({ round: 6, examined: true })).toBe('stop');
  });
});

describe('planPressureFor — with a window', () => {
  const at = (fill: number | undefined, round = 5) =>
    planPressureFor({ round, examined: true, contextWindow: 24_576, fill });

  it('takes the gentler of fill and round count', () => {
    expect(at(0.1, 9)).toBe('none'); // plenty of room: rounds alone never press
    expect(at(0.45, 5)).toBe('soft');
    expect(at(0.65, 5)).toBe('firm');
    expect(at(0.85, 6)).toBe('stop');
    expect(at(0.85, 1)).toBe('soft'); // full early: never harder than the round schedule
    expect(at(0.85, 3)).toBe('firm');
  });

  // The observed case: a 1M window, ~32k used, told "very likely have enough" at round 3 and
  // STOP at 6, and it planned around files it never opened.
  it('leaves a large, mostly-empty window alone at the rounds that used to stop it', () => {
    const fill = planFill(31_840, 1_000_000);
    for (const round of [3, 6, 11]) {
      expect(planPressureFor({ round, examined: true, contextWindow: 1_000_000, fill })).toBe(
        'none',
      );
    }
  });

  it('says nothing before the turn has a measurement or has examined anything', () => {
    expect(at(undefined)).toBe('none');
    expect(planPressureFor({ round: 5, examined: false, contextWindow: 24_576, fill: 0.9 })).toBe(
      'none',
    );
  });

  // Observed on a 24k window: fill alone said STOP at round 3 ("my knowledge is thin… the
  // instructions say to stop"), and the plan skipped the types, the dispatch and the approval rules.
  it('follows the old schedule on a small window, apart from a free first round', () => {
    const fills = [undefined, 0.25, 0.58, 0.82, 0.97, 0.97, 0.97];
    const tiers = fills.map((fill, round) =>
      planPressureFor({ round, examined: round > 0, contextWindow: 24_576, fill }),
    );
    expect(tiers).toEqual(['none', 'none', 'soft', 'firm', 'firm', 'firm', 'stop']);
  });
});

describe('planPressureLine', () => {
  it('names the fill when there is one and the rounds when there is not', () => {
    expect(planPressureLine('firm', { round: 4, fillPercent: 63 })).toContain(
      'The context is 63% full',
    );
    expect(planPressureLine('firm', { round: 4 })).toContain('explored across 4 rounds');
  });

  it('adds no line when there is no pressure', () => {
    expect(planPressureLine('none', { round: 2 })).toBeUndefined();
  });
});
