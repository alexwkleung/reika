import type { Usage } from '../types.js';
import type { PrefixDivergence } from './prefixtrace.js';

// What the prefix divergence measured in prefixtrace.ts actually COST (issue #195). On a slow local
// endpoint prefill is ~80% of a turn's wall clock, and a `cause=mid-history` line reads as a minor
// note until it is annotated with "8,952 tokens, ~6.5 min" — which is what it was. Everything here
// is REIKA_DEBUG-only measurement: no threshold reads these numbers, nothing changes behavior.

// An LCP-style prompt cache reuses KV state up to the first differing byte, so everything after the
// divergence point is re-processed — including a pure append's new tail.
export function reprocessedTokens(d: PrefixDivergence, promptTokens: number): number {
  if (promptTokens <= 0) return 0;
  if (d.totalChars <= 0) return promptTokens;
  const stable = Math.min(Math.max(d.stableChars, 0), d.totalChars);
  return Math.round(promptTokens * (1 - stable / d.totalChars));
}

// The char-fraction estimate above is a proxy; a provider that reports cache hits knows the real
// number. Prefer it when present so the learned rate isn't fitted to a proxy's error.
export function sampleTokens(usage: Usage | undefined, estimated: number): number {
  if (usage?.promptTokens && usage.cachedTokens != null) {
    return Math.max(0, usage.promptTokens - usage.cachedTokens);
  }
  return estimated;
}

// Time-to-first-token is prefill plus a fixed per-request overhead (queueing, template, the first
// decode step). Only rounds that reprocessed enough to swamp that overhead may teach the rate — an
// append-only round of 40 tokens behind a 2 s handshake would "measure" 20 tok/s.
const MIN_SAMPLE_TOKENS = 512;
const MIN_SAMPLE_MS = 200;
// Plausible prefill throughput spans a heavily-quantized CPU model to a datacenter GPU; outside
// this band the sample is a stall or a clock artifact, not a rate.
const MIN_RATE = 1;
const MAX_RATE = 200_000;
// Smoothed rather than last-sample: prefill rate drifts with how full the KV cache already is, and
// a single queued round shouldn't move the estimate the next line prints.
const ALPHA = 0.3;

export class PrefillRate {
  private rate: number | undefined;

  // Seeded from the prior turn's learned rate — each turn re-seeds history from the UI scrollback,
  // so without this the most expensive round of a session (a turn's round 0) always prints `est=?`.
  constructor(seed?: number) {
    if (seed && seed >= MIN_RATE && seed <= MAX_RATE) this.rate = seed;
  }

  // Returns the updated rate when the sample was usable, undefined when it was rejected.
  observe(tokens: number, ms: number): number | undefined {
    if (tokens < MIN_SAMPLE_TOKENS || ms < MIN_SAMPLE_MS) return undefined;
    const observed = tokens / (ms / 1000);
    if (observed < MIN_RATE || observed > MAX_RATE) return undefined;
    this.rate = this.rate == null ? observed : this.rate * (1 - ALPHA) + observed * ALPHA;
    return this.rate;
  }

  get(): number | undefined {
    return this.rate;
  }

  estimateSeconds(tokens: number): number | undefined {
    if (this.rate == null || this.rate <= 0) return undefined;
    return tokens / this.rate;
  }
}

// The suffix appended to the `prefix-cache` debug line: what the round's divergence costs, in the
// two units that matter. `?` (not a silent omission) while the rate is still unlearned, so a
// missing estimate never reads as a cheap round. `bounded` swaps `=` for `≤` on the round the trace
// has no baseline for (a turn's first request): the engine usually still holds the previous turn's
// prefix, so the full prompt is a ceiling on what it re-processed, not a measurement.
export function formatPrefillCost(tokens: number, rate?: number, bounded = false): string {
  const seconds = rate != null && rate > 0 ? tokens / rate : undefined;
  const eq = bounded ? '\u2264' : '=';
  return (
    `reprocess${eq}${tokens}tok ` +
    `est${eq}${seconds == null ? '?' : formatSeconds(seconds)} ` +
    `rate=${rate == null ? '?' : formatRate(rate)}`
  );
}

function formatSeconds(s: number): string {
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

function formatRate(r: number): string {
  return r >= 10 ? `${Math.round(r)}t/s` : `${r.toFixed(1)}t/s`;
}
