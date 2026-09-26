import { DEFAULT_MIN_GEN_TOKENS } from '../provider/budget.js';
import type { Config } from '../types.js';

// The generation reserve, learned from what the model actually generates (#551). The reserve is
// the one budget number that used to be a guess: calibration, the prefill and decode rates and the
// window are all learned or probed, while REIKA_MIN_GEN_TOKENS was a constant a plug-and-play user
// never hears about. It does not cap output (max_tokens is window − prompt − margin); it moves the
// compaction trigger, so it binds only on the rounds just before a fold — where a thinking model on
// a 16–32k window wanting 4–8k of think-room was cut off by a 2048 reserve.
//
// A high percentile, not an EMA like the rates: a reserve has to cover the big rounds, and an
// average of a thinking model's short tool-call rounds and long planning rounds sits under the ones
// that get cut. It only ever raises the configured floor, so a model that never needs more behaves
// exactly as before; an explicit REIKA_MIN_GEN_TOKENS pins it with no learning on top.
const RESERVE_SAMPLES = 16;
const RESERVE_PERCENTILE = 0.9;
// The next big round can exceed the last ones; 1.25 on top of p90 covers the spread observed
// between a thinking model's planning rounds without doubling the reserve.
const RESERVE_HEADROOM = 1.25;
// One outlier must not permanently shrink the usable window: past a quarter of it, the rest is
// continuation's job (#284). The floor wins over the cap on a window too small to share.
const RESERVE_WINDOW_SHARE = 0.25;
// Rounded up so the compaction threshold moves in steps rather than on every round.
const RESERVE_STEP = 256;

// Only a round that ended on its own measures demand. A `length` cut measures the budget it was
// given, and an aborted spiral would inflate the reserve with exactly the output it exists to stop.
const MEASURING_FINISHES = new Set(['stop', 'tool_calls']);

export type GenReserveSource = 'pinned' | 'learned' | 'default';

export class GenReserve {
  private samples: number[] = [];

  observe(completionTokens: number | undefined, finishReason: string | undefined): void {
    if (!completionTokens || completionTokens <= 0) return;
    if (!finishReason || !MEASURING_FINISHES.has(finishReason)) return;
    this.samples.push(completionTokens);
    if (this.samples.length > RESERVE_SAMPLES) this.samples.shift();
  }

  // The learned reserve for this window above `floor`, or undefined when nothing observed needs
  // more than the floor already gives.
  learned(floor: number, window?: number): number | undefined {
    if (this.samples.length === 0) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p = sorted[Math.ceil(RESERVE_PERCENTILE * sorted.length) - 1];
    const wanted = Math.ceil((p * RESERVE_HEADROOM) / RESERVE_STEP) * RESERVE_STEP;
    const capped = window ? Math.min(wanted, Math.floor(window * RESERVE_WINDOW_SHARE)) : wanted;
    return capped > floor ? capped : undefined;
  }
}

// The reserve a request should be budgeted with, and where it came from (for the debug line).
// `minGenAdaptive` is set only by loadConfig for a profile with no explicit REIKA_MIN_GEN_TOKENS,
// so a hand-built Config — every test — stays pinned at its own number.
export function resolveGenReserve(
  config: Pick<Config, 'minGenTokens' | 'minGenAdaptive' | 'contextWindow'>,
  reserve?: GenReserve,
): { tokens: number; source: GenReserveSource } {
  const floor = config.minGenTokens ?? DEFAULT_MIN_GEN_TOKENS;
  if (!config.minGenAdaptive) return { tokens: floor, source: 'pinned' };
  const learned = reserve?.learned(floor, config.contextWindow);
  return learned ? { tokens: learned, source: 'learned' } : { tokens: floor, source: 'default' };
}

// The config with its reserve resolved, for a caller that must see the same number the next round
// will (the KV warm's round-0 prefix, the status gauge).
export function withGenReserve<C extends Config>(config: C, reserve?: GenReserve): C {
  const { tokens } = resolveGenReserve(config, reserve);
  return tokens === config.minGenTokens ? config : { ...config, minGenTokens: tokens };
}
