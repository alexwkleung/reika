import type { EngineTimings, ModelResponse } from '../provider/client.js';
import type { Usage } from '../types.js';

// Decode throughput for the round that just finished (#204, #536). Two ways to get one, and the
// order between them is the point:
//
//   1. The engine reports it. llama.cpp attaches a `timings` object to the final chunk of its `/v1`
//      stream carrying the tokens it predicted, the window it decoded them in and the rate it
//      computed from the pair — its own clock, its own count, over the window it actually decoded
//      in. Nothing to derive, so nothing to be wrong. This is the local-endpoint path, and a local
//      engine is the one where an estimate's error is large enough to read (#536: the derived rate
//      ran 1.5–2.5 tok/s above the server's own).
//   2. We derive it. An OpenAI-compatible API reports no such thing, so the number comes from the
//      two facts that wire does give: `ModelResponse.timing` splits the call into prefill (TTFT)
//      and decode (everything after it), and `usage.completionTokens` says how many tokens came out
//      of it. It stays an approximation — a hosted engine's rate can only ever be estimated — which
//      is exactly why the reported one wins wherever an engine offers it.
//
// Decode ONLY, deliberately. Prefill has a rate too (`agent/prefillcost.ts`), but it stays a debug
// number: what a round reprocessed is an estimate built on a char-fraction proxy, and its clock
// starts before the request is sent, so it is honest enough to price a wait in the log and not
// honest enough to print as the model's throughput. Decode is measured between two events that both
// really happened (first generated token → stream end) over a count an engine tallied itself.
//
// Smoothed rather than last-sample, the way PrefillRate is: a decode window is short on any fast
// engine — 40 tokens at 100 tok/s is 0.4 s of clock, where one late chunk moves the quotient by tens
// of tok/s — and what a user reads off the status bar is "how fast does this model decode", not
// "what did that one tool round happen to measure". The fold is over whichever samples the rounds
// offered, reported or derived: the two sources agree on what they are measuring, so they are
// interchangeably foldable, and a session that switches engines (a subagent on another endpoint)
// starts a new learner rather than blending the two. What the smoothing must NOT do is stand in
// for the source: it is why the debug line prints the round's own sample next to the smoothed one.
const ALPHA = 0.3;

// A sample under either bound teaches nothing: the window is too short to separate a rate from the
// engine's chunking, or too few tokens for the quotient to be about throughput at all. Rejected
// rather than folded in, so the displayed rate stays the last measurable one. Applied to reported
// and derived samples alike — it is the same round and the same window either way.
const MIN_SAMPLE_TOKENS = 16;
const MIN_SAMPLE_MS = 200;
// Plausible decode throughput spans a heavily-quantized model on a stalled CPU to a wafer-scale
// engine; outside this band the sample is a clock or accounting artifact, not a rate.
const MIN_RATE = 0.1;
const MAX_RATE = 10_000;

// The engine's own rate, when it reported stats that can carry a measurement (#536). Undefined when
// it reported none — every hosted API — or reported something unusable. Both bounds mean the same thing here as they do there, on the
// engine's own count and window rather than on ours: it is the same round, so it is measurable under
// both sources or under neither, and a rate that arrives without the pair it was computed from is
// not read at all (client.ts requires the trio) because nothing here could then tell a measurement
// from a number.
export function engineDecodeRate(timings?: EngineTimings): number | undefined {
  if (!timings) return undefined;
  // `predictedN` counts every token the round produced; the rate divides the decode steps that
  // produced them, and the first token is free — it falls out of the last prompt batch's logits —
  // so the engine's window, and the quotient above it, are about the remaining n-1. Checking the
  // full count here would let the rounds this bound exists for through it.
  if (timings.predictedN - 1 < MIN_SAMPLE_TOKENS || timings.predictedMs < MIN_SAMPLE_MS)
    return undefined;
  const rate = timings.perSecond;
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) return undefined;
  return rate;
}

// One finished round's sample, and which of the two sources it came from. The source travels with
// the number because there are two (#536) and the debug line has to be able to say which one the
// chip folded in: a rate with no provenance is exactly what made #536 unreadable from a log — the
// derived number sat 1.5–2.5 tok/s above the engine's own and nothing on the `round=` line said so.
export type DecodeSample = { rate: number; source: 'engine' | 'derived' };

// This round's decode rate (tokens/second), or undefined when that round cannot carry a
// measurement: no engine stats and no timing (nothing ever streamed), no provider token count, or a
// window under the bounds above. Undefined is the only signal a caller gets that the sample was
// rejected — the learner keeps the rate it already had. The derivation is only for the endpoints
// that report nothing: when the engine reported stats and rejected its own round, the derivation
// would admit that same round against a looser bound (the full count over a longer window) at the
// rate #536 measured running high, so a rejected engine round offers no sample at all.
export function decodeSample(
  usage: Usage | undefined,
  timing: ModelResponse['timing'],
  engine?: EngineTimings,
): DecodeSample | undefined {
  if (engine) {
    const reported = engineDecodeRate(engine);
    return reported != null ? { rate: reported, source: 'engine' } : undefined;
  }
  const derived = derivedDecodeRate(usage, timing);
  return derived != null ? { rate: derived, source: 'derived' } : undefined;
}

// The derived sample — the fallback source, for the endpoints that report no stats of their own.
// Exported for its own tests; the round's answer comes from `decodeSample`, which is the one place
// that decides between the two sources.
export function derivedDecodeRate(
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

  // Returns the smoothed rate when the round offered a sample, undefined when it offered none.
  // Takes a `DecodeSample` rather than the facts behind it so the fold cannot pick a different
  // sample than the one the debug line printed: provenance is decided once, in `decodeSample`.
  observe(sample?: DecodeSample): number | undefined {
    if (!sample) return undefined;
    this.rate = this.rate == null ? sample.rate : this.rate * (1 - ALPHA) + sample.rate * ALPHA;
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

// `<rate>tok/s`, or `?` when there is no number to print — the debug line's field shape, and the
// ONLY rendering of a rate that reaches a log line: `prefillcost.ts` imports this one for the
// prefill rate it prints, so both lines state a rate identically. The chip's is `ui/format.ts`'s
// formatTokensPerSecond (a space, no `?`); this one is for the log, where an absent value is stated
// rather than omitted (a missing field reads as a cheap round), and where four digits want no
// decimal. Both spell the unit `tok/s`, so the log and the chip agree on what the number IS even
// where they disagree on how to print it. The unit is part of the field, not decoration: a parser
// matching this line has to match `tok/s` too (`evals/prefixcost-report.ts`).
export function formatRate(rate?: number): string {
  if (rate == null) return '?';
  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}tok/s`;
}
