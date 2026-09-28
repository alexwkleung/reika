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
// Loops are not this module's job: the novelty stall and the reasoning-loop break force the write
// whatever the window. The round ceiling lives here because it is the last rung of this ladder.

export type PlanPressure = 'none' | 'soft' | 'firm' | 'stop';

// Fractions of the compaction threshold at which each tier starts.
const SOFT_FILL = 0.4;
const FIRM_FILL = 0.6;
const STOP_FILL = 0.8;

const LEVELS: PlanPressure[] = ['none', 'soft', 'firm', 'stop'];

// The original round-count schedule: the whole rule without a window, the ceiling with one.
const FIRM_ROUND = 3;
const STOP_ROUND = 6;

// The round ceiling: a backstop against a model that keeps finding trivially-new things, since the
// novelty stall and the loop breakers already end a finished or a stuck exploration. 12 is sized for
// ~16k windows, where the model over-gathers against the plan write's findings budget well before
// then (~26k tokens read against ~10k), so later rounds gather what the write cannot hold. While the
// write CAN still hold everything gathered, it is 30: a 1M-window API run was cut at 12 having
// gathered a fraction of that budget, with fill pressure never above `none`. Keyed on the budget,
// not on fill, because fill does not climb on a small window — the shed holds it near half while
// the model keeps reading (measured: 0.49 at round 12 on 24k), so a fill rule handed small models 30.
const ROUND_CEILING = 12;
const ROOMY_ROUND_CEILING = 30;
// With the roomy ceiling the fill schedule can stay `none` to the end, so the ceiling would land
// unannounced. Ramp to firm this many rounds before it, and to STOP on its last round.
const CEILING_FIRM_ROUNDS = 3;

export function planRoundCeiling(opts: {
  // The plan write's findings budget in chars; undefined without a window.
  transformBudgetChars?: number;
  gatheredChars: number;
}): number {
  if (opts.transformBudgetChars === undefined) return ROUND_CEILING;
  return opts.gatheredChars < opts.transformBudgetChars ? ROOMY_ROUND_CEILING : ROUND_CEILING;
}

// Only the roomy ceiling ramps: under 12 the round schedule has already said STOP at 6.
export function ceilingPressure(round: number, ceiling: number): PlanPressure {
  if (ceiling <= ROUND_CEILING) return 'none';
  if (round >= ceiling - 1) return 'stop';
  if (round >= ceiling - CEILING_FIRM_ROUNDS) return 'firm';
  return 'none';
}

export function planPressureFor(opts: {
  round: number;
  examined: boolean;
  contextWindow?: number;
  // The turn's peak planFill; undefined at round 0, which the warm prefix cannot measure.
  fill?: number;
  // When given, pressure never trails the approach to it (see CEILING_FIRM_ROUNDS).
  ceiling?: number;
}): PlanPressure {
  const byRound = roundPressure(opts.round, opts.examined);
  if (!opts.contextWindow) return byRound;
  const gentler = Math.min(LEVELS.indexOf(byRound), LEVELS.indexOf(fillPressure(opts)));
  const ramp =
    opts.ceiling === undefined ? 0 : LEVELS.indexOf(ceilingPressure(opts.round, opts.ceiling));
  return LEVELS[Math.max(gentler, ramp)];
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
