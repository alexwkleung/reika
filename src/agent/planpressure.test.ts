import { describe, expect, it } from 'vitest';
import {
  ceilingPressure,
  planFill,
  planPressureFor,
  planPressureLine,
  planRoundCeiling,
} from './planpressure.js';

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

describe('planRoundCeiling', () => {
  it('keeps 12 without a window to size the plan write against', () => {
    expect(planRoundCeiling({ gatheredChars: 0 })).toBe(12);
  });

  // The observed case: a 1M-window API run cut at round 12 having gathered ~200k chars against a
  // write budget of ~3.4M.
  it('allows 30 rounds while the write can still hold everything gathered', () => {
    expect(planRoundCeiling({ transformBudgetChars: 3_386_070, gatheredChars: 200_000 })).toBe(30);
  });

  // A 24k window's write holds ~70k chars — a handful of reads — so small models keep today's 12.
  it('falls back to 12 once the gathered findings outgrow the write budget', () => {
    expect(planRoundCeiling({ transformBudgetChars: 69_632, gatheredChars: 69_632 })).toBe(12);
    expect(planRoundCeiling({ transformBudgetChars: 69_632, gatheredChars: 90_000 })).toBe(12);
  });
});

describe('ceiling ramp', () => {
  it('goes firm three rounds out and STOP on the last round', () => {
    expect([25, 26, 27, 28, 29].map(r => ceilingPressure(r, 30))).toEqual([
      'none',
      'none',
      'firm',
      'firm',
      'stop',
    ]);
  });

  it('adds nothing under the 12-round ceiling, whose schedule already said STOP at 6', () => {
    expect(ceilingPressure(11, 12)).toBe('none');
  });

  // Without the ramp a roomy window stays at `none` to the last round and the write lands unannounced.
  it('raises a roomy window above the fill schedule as the ceiling nears', () => {
    const at = (round: number) =>
      planPressureFor({
        round,
        examined: true,
        contextWindow: 1_000_000,
        fill: 0.07,
        ceiling: 30,
      });
    expect([20, 27, 29].map(at)).toEqual(['none', 'firm', 'stop']);
  });

  it('never lowers pressure the fill schedule already set', () => {
    expect(
      planPressureFor({ round: 7, examined: true, contextWindow: 24_576, fill: 0.9, ceiling: 12 }),
    ).toBe('stop');
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
