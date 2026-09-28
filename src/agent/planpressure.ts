import { compactThreshold } from './compaction.js';

// EXPERIMENT (plan mode): how hard the exploration ledger pushes toward writing the plan.
//
// Two schedules, and the GENTLER one wins. The round count (soft once anything is examined, "very
// likely have enough" at 3, STOP at 6) is what works on ~16–24k windows. On a large window it cut a
// one-shot plan short with the context ~3% full: the model obeyed ("I've been told I have enough")
// and planned around files it never opened. Fill against the compaction threshold frees that case.
// Fill alone was tried and is too hard on a small window: it said STOP at round 3 of a 24k run
// ("my knowledge is thin… the instructions say to stop"), where the old schedule kept exploring and
// the shed carried it past the threshold. Taking the minimum means pressure is never stronger than
// the schedule that worked on small windows, and never stronger than the room warrants on large ones.
// Loops are not this module's job: the novelty stall, the reasoning-loop break and the hard round
// ceiling still force the write whatever the window.

export type PlanPressure = 'none' | 'soft' | 'firm' | 'stop';

// Fractions of the compaction threshold at which each tier starts.
const SOFT_FILL = 0.4;
const FIRM_FILL = 0.6;
const STOP_FILL = 0.8;

const LEVELS: PlanPressure[] = ['none', 'soft', 'firm', 'stop'];

// The original round-count schedule: the whole rule without a window, the ceiling with one.
const FIRM_ROUND = 3;
const STOP_ROUND = 6;

export function planPressureFor(opts: {
  round: number;
  examined: boolean;
  contextWindow?: number;
  // The turn's peak planFill; undefined at round 0, which the warm prefix cannot measure.
  fill?: number;
}): PlanPressure {
  const byRound = roundPressure(opts.round, opts.examined);
  if (!opts.contextWindow) return byRound;
  return LEVELS[Math.min(LEVELS.indexOf(byRound), LEVELS.indexOf(fillPressure(opts)))];
}

function roundPressure(round: number, examined: boolean): PlanPressure {
  if (round >= STOP_ROUND) return 'stop';
  if (round >= FIRM_ROUND) return 'firm';
  return examined ? 'soft' : 'none';
}

function fillPressure(opts: { examined: boolean; fill?: number }): PlanPressure {
  const fill = opts.fill;
  if (fill === undefined || !opts.examined) return 'none';
  if (fill >= STOP_FILL) return 'stop';
  if (fill >= FIRM_FILL) return 'firm';
  if (fill >= SOFT_FILL) return 'soft';
  return 'none';
}

// Callers hold the turn's PEAK fill, not the latest: a compaction fold drops the fill, and a model
// told STOP a round ago that is suddenly told nothing reads it as permission to explore again.
export function planFill(
  promptTokens: number,
  contextWindow: number,
  minGenTokens?: number,
): number {
  return promptTokens / compactThreshold(contextWindow, minGenTokens);
}

// The firm line names the observation that earned it — fill with a window, rounds without one —
// since a stated fact is what this class of model acts on, where a bare "you have enough" is a claim.
export function planPressureLine(
  pressure: PlanPressure,
  basis: { fillPercent?: number; round: number },
): string | undefined {
  if (pressure === 'stop') {
    return 'STOP. Call no more tools. Write the numbered plan from what you already have.';
  }
  if (pressure === 'firm') {
    const observed =
      basis.fillPercent !== undefined
        ? `The context is ${basis.fillPercent}% full and you`
        : `You have explored across ${basis.round} rounds and`;
    return (
      `${observed} very likely have enough. Write the numbered plan now unless one specific ` +
      'unknown truly blocks you.'
    );
  }
  if (pressure === 'soft') {
    return 'If you can already describe the steps, STOP exploring and write the numbered plan.';
  }
  return undefined;
}
