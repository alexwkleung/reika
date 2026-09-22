import type { ModelResponse } from '../provider/client.js';
import type { Usage } from '../types.js';

// Decode throughput for the round that just finished (#204). Providers do not report tokens per
// second: llama.cpp puts its own decode stats in the final chunk of its `/v1` stream, and an
// OpenAI-compatible API reports nothing at all — so the status bar's number is derived from the two
// facts the wire does give us. `ModelResponse.timing` splits the call into prefill (TTFT) and decode
// (everything after it), and `usage.completionTokens` says how many tokens came out of it.
//
// Decode ONLY, deliberately. Prefill has a rate too (`agent/prefillcost.ts`), but it stays a debug
// number: what a round reprocessed is an estimate built on a char-fraction proxy, and its clock
// starts before the request is sent, so it is honest enough to price a wait in the log and not
// honest enough to print as the model's throughput. Decode is measured between two events that both
// really happened (first generated token → stream end) over a count the provider tallied itself.
//
// Smoothed rather than last-sample, the way PrefillRate is: a decode window is short on any fast
// engine — 40 tokens at 100 tok/s is 0.4 s of clock, where one late chunk moves the quotient by tens
// of tok/s — and what a user reads off the status bar is "how fast does this model decode", not
// "what did that one tool round happen to measure".
const ALPHA = 0.3;

// A sample under either bound teaches nothing: the window is too short to separate a rate from the
// engine's chunking, or too few tokens for the quotient to be about throughput at all. Rejected
// rather than folded in, so the displayed rate stays the last measurable one.
const MIN_SAMPLE_TOKENS = 16;
const MIN_SAMPLE_MS = 200;
// Plausible decode throughput spans a heavily-quantized model on a stalled CPU to a wafer-scale
// engine; outside this band the sample is a clock or accounting artifact, not a rate.
const MIN_RATE = 0.1;
const MAX_RATE = 10_000;

// One finished call's decode rate (tokens/second), or undefined when that call cannot carry a
// measurement: no timing (nothing ever streamed), no provider token count, or a window under the
// bounds above. Undefined is the only signal a caller gets that the sample was rejected — the
// learner keeps the rate it already had.
export function decodeRate(
  usage: Usage | undefined,
  timing: ModelResponse['timing'],
): number | undefined {
  if (!usage || !timing) return undefined;
  const ms = timing.totalMs - timing.ttftMs;
  if (usage.completionTokens < MIN_SAMPLE_TOKENS || ms < MIN_SAMPLE_MS) return undefined;
  const observed = usage.completionTokens / (ms / 1000);
  if (observed < MIN_RATE || observed > MAX_RATE) return undefined;
  return observed;
}

export class DecodeRate {
  private rate: number | undefined;

  // Seeded from the prior turn's rate — each turn re-seeds history from the UI scrollback, so
  // without this the first round of every turn would have nothing to show.
  constructor(seed?: number) {
    if (seed && seed >= MIN_RATE && seed <= MAX_RATE) this.rate = seed;
  }

  // Returns the smoothed rate when the round was usable, undefined when it was rejected.
  observe(usage: Usage | undefined, timing: ModelResponse['timing']): number | undefined {
    const sample = decodeRate(usage, timing);
    if (sample == null) return undefined;
    this.rate = this.rate == null ? sample : this.rate * (1 - ALPHA) + sample * ALPHA;
    return this.rate;
  }

  get(): number | undefined {
    return this.rate;
  }

  // Takes over a rate another learner smoothed on the same engine (a subagent's), so the next
  // observation continues from what the chip is showing instead of from before it.
  adopt(rate: number): void {
    this.rate = rate;
  }
}

// `<rate>t/s`, or `?` when there is no number to print — the debug line's field shape. The chip's
// is `ui/format.ts`'s formatTokensPerSecond (a space, no `?`); this one is for the log, where an
// absent value is stated rather than omitted (a missing field reads as a cheap round), and where
// four digits want no decimal. Same shape `prefillcost.ts` gives the rate it logs.
export function formatRate(rate?: number): string {
  if (rate == null) return '?';
  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}t/s`;
}
