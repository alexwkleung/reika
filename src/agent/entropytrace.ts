// Debug-only drift instrumentation (issue #134): per-round entropy and KL divergence, so a run
// leaves behind quantifiable numbers for *where* a model came apart instead of only the categorical
// verdicts the loop detectors emit. Two independent things are measured, and they answer different
// questions:
//
//   - Entropy — how uncertain the model was. With logprobs from the engine this is the real
//     predictive entropy of the sampling distribution (plus the surprisal of what it actually
//     emitted); without them it's the empirical entropy of the round's own output distribution.
//   - KL divergence — how far this round's output distribution moved from the previous round
//     (`klPrev`) and from where the turn started (`klBase`). This is the drift axis: a spiral shows
//     up as klPrev collapsing toward 0 (round after round drawn from the same distribution) while
//     klBase sits high (it has drifted somewhere and stayed there).
//
// Nothing here steers the model. The issue is explicit that these numbers vary between runs and
// should be *observed* before anything dynamic is built on them, so this module only measures, and
// only the REIKA_DEBUG log consumes it. Pure + tested so thresholds can be calibrated against real
// transcripts later. See loop.ts for the wiring.
import type { SampledToken } from '../types.js';

// Additive (Lidstone) smoothing for KL. Unsmoothed KL is infinite the moment this round uses a word
// the previous round never did — which is every healthy round — so the raw quantity is unusable
// without it. Smoothing over the *union* support keeps every comparison finite and bounded while
// preserving the ordering that matters (near-identical rounds → ~0, unrelated rounds → large).
// 0.5 (Jeffreys) rather than 1.0: full Laplace over a large union vocabulary flattens both sides so
// hard that real drift is damped out of the signal.
const KL_ALPHA = 0.5;

// Word-level units for the empirical distributions. Deliberately the same shape as the shingle
// tokenizer in reasoningtrace.ts (lowercased, punctuation dropped) so the two diagnostics describe
// the same text the same way — and deliberately NOT the model's tokenizer: the distributions must be
// comparable across rounds even when a round has no logprobs at all.
export function textTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

export function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

// Shannon entropy of a count distribution, in nats. `normalized` divides by log(total) — the
// entropy this round WOULD have had if every token were distinct — giving a 0..1 reading of how
// much of the available variety the round actually used. All-distinct output pins it at 1; a
// repeated span drives it down (a round that says the same three words nine times reads 0.5).
// Normalizing by log(distinct) instead would be blind to exactly that: any uniform distribution
// reads 1.0 however many times it repeats itself.
//
// The tradeoff is a mild length bias — distinct vocabulary grows sublinearly with length, so a long
// healthy round reads lower than a short one. Compare rounds of similar length, or read the raw
// `entropy` (which has no such normalization) alongside it. Both are 0 for a distribution with
// nothing to spread: empty, one token, or one symbol repeated.
export function empiricalEntropy(counts: Map<string, number>): {
  entropy: number;
  normalized: number;
} {
  let total = 0;
  for (const c of counts.values()) total += c;
  if (total <= 1 || counts.size <= 1) return { entropy: 0, normalized: 0 };
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / total;
    entropy -= p * Math.log(p);
  }
  return { entropy, normalized: entropy / Math.log(total) };
}

// KL(p ‖ q) in nats over the union support, with additive smoothing (see KL_ALPHA). Asymmetric on
// purpose: p is the round being judged, q the reference it is measured against, so the divergence is
// weighted by what the *current* round actually says. Returns 0 when either side is empty — no
// evidence, not "identical".
export function klDivergence(
  p: Map<string, number>,
  q: Map<string, number>,
  alpha = KL_ALPHA,
): number {
  if (p.size === 0 || q.size === 0) return 0;
  const support = new Set([...p.keys(), ...q.keys()]);
  let pTotal = 0;
  for (const c of p.values()) pTotal += c;
  let qTotal = 0;
  for (const c of q.values()) qTotal += c;
  const pDenom = pTotal + alpha * support.size;
  const qDenom = qTotal + alpha * support.size;

  let kl = 0;
  for (const w of support) {
    const pw = ((p.get(w) ?? 0) + alpha) / pDenom;
    const qw = ((q.get(w) ?? 0) + alpha) / qDenom;
    kl += pw * Math.log(pw / qw);
  }
  return kl;
}

// What the engine's logprobs say about this round, when it returned any.
export type LogprobStats = {
  // Positions with a sampled logprob — how much of the round these numbers actually describe.
  positions: number;
  // Mean −log p of the tokens the model emitted (nats). Low = it said what it was confident in.
  surprisal: number;
  // Mean per-position entropy over the reported top-k candidates (nats). Undefined when the engine
  // returned logprobs but no top_logprobs (surprisal is still measurable; entropy is not).
  entropy?: number;
  // Mean probability mass the top-k covers. The entropy above is computed RAW over the reported
  // candidates — it is a lower bound on the true entropy, and this says how tight that bound is
  // (0.98 = the top-k is nearly the whole distribution; 0.40 = a long tail is unmeasured).
  // Renormalizing instead would silently claim precision the truncated list doesn't have.
  coverage?: number;
};

export function logprobStats(tokens: SampledToken[]): LogprobStats | null {
  if (tokens.length === 0) return null;
  let surprisalSum = 0;
  let entropySum = 0;
  let coverageSum = 0;
  let withTop = 0;
  for (const t of tokens) {
    surprisalSum += -t.logprob;
    if (!t.top || t.top.length === 0) continue;
    withTop++;
    let h = 0;
    let mass = 0;
    for (const c of t.top) {
      const p = Math.exp(c.logprob);
      mass += p;
      if (p > 0) h -= p * Math.log(p);
    }
    entropySum += h;
    coverageSum += mass;
  }
  return {
    positions: tokens.length,
    surprisal: surprisalSum / tokens.length,
    ...(withTop > 0 ? { entropy: entropySum / withTop, coverage: coverageSum / withTop } : {}),
  };
}

export type EntropyReading = {
  // Where the headline entropy came from: the engine's own distribution, or the round's output.
  source: 'logprobs' | 'text';
  // Word-tokens in this round's emitted text — the sample size behind the empirical numbers.
  tokens: number;
  // Empirical entropy of the round's output distribution (nats) and its 0..1 normalization.
  // Always present: it is the one measurement every backend can produce.
  entropy: number;
  normalized: number;
  // Engine-reported measurements, present only when logprobs came back for this round.
  logprobs?: LogprobStats;
  // Divergence of this round's output distribution from the previous round, and from the turn's
  // first round. Both 0 on the first round (nothing to compare against yet).
  klPrev: number;
  klBase: number;
};

// Per-turn drift recorder. One `record` per model round, in order. Turn-scoped like PrefixTrace:
// the baseline is *this turn's* first round, so klBase reads as "how far the model has moved since
// it started working on this request" — a comparison that stays meaningful, unlike one spanning
// unrelated requests.
export class EntropyTrace {
  private prev?: Map<string, number>;
  private base?: Map<string, number>;
  private readings: EntropyReading[] = [];

  // Record one round. `text` is everything the model emitted (reasoning + content) — reasoning is
  // included deliberately: on a thinking model it is most of the round, and it is where rumination
  // shows up first. `sampled` is the engine's logprobs when it returned them; those typically cover
  // only the content channel, which is why they inform the entropy columns but never the KL ones —
  // mixing per-channel and whole-round distributions across rounds would make klPrev meaningless.
  // Returns null for a round with nothing to measure (no text, no logprobs), so the caller can skip
  // logging a line about nothing.
  record(round: { text: string; sampled?: SampledToken[] }): EntropyReading | null {
    const counts = tokenCounts(textTokens(round.text));
    const lp = round.sampled && round.sampled.length > 0 ? logprobStats(round.sampled) : null;
    if (counts.size === 0 && !lp) return null;

    const { entropy, normalized } = empiricalEntropy(counts);
    const reading: EntropyReading = {
      source: lp?.entropy != null ? 'logprobs' : 'text',
      tokens: [...counts.values()].reduce((a, b) => a + b, 0),
      entropy,
      normalized,
      ...(lp ? { logprobs: lp } : {}),
      klPrev: this.prev ? klDivergence(counts, this.prev) : 0,
      klBase: this.base ? klDivergence(counts, this.base) : 0,
    };

    // Only a round that produced text updates the references — a text-less round (a bare tool call)
    // would otherwise reset the comparison to an empty distribution and blank out the drift signal
    // for every round after it.
    if (counts.size > 0) {
      if (!this.base) this.base = counts;
      this.prev = counts;
    }
    this.readings.push(reading);
    return reading;
  }

  // One-line turn rollup for the debug log, mirroring ReadTrace.summary(). Empty string when
  // nothing was recorded, so the caller can skip the line.
  summary(): string {
    if (this.readings.length === 0) return '';
    const h = this.readings.map(r => r.logprobs?.entropy ?? r.entropy);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const kls = this.readings.slice(1).map(r => r.klPrev);
    const last = this.readings[this.readings.length - 1];
    const src = this.readings.some(r => r.source === 'logprobs') ? 'logprobs' : 'text';
    return (
      `rounds=${this.readings.length} src=${src} ` +
      `H=${mean(h).toFixed(2)}avg(${Math.min(...h).toFixed(2)}..${Math.max(...h).toFixed(2)}) ` +
      `klPrev=${kls.length > 0 ? mean(kls).toFixed(2) : 'n/a'}avg ` +
      `klBase=${last.klBase.toFixed(2)}final`
    );
  }
}

// Render a reading as the body of its REIKA_DEBUG line. Kept next to the type (and tested) so the
// format the analysis scripts grep for is defined in one place rather than inline in the loop.
export function formatEntropyReading(r: EntropyReading): string {
  const lp = r.logprobs;
  const head =
    lp?.entropy != null
      ? `src=logprobs H=${lp.entropy.toFixed(2)}n cover=${(lp.coverage ?? 0).toFixed(2)} ` +
        `surprisal=${lp.surprisal.toFixed(2)}n outH=${r.entropy.toFixed(2)}`
      : `src=text H=${r.entropy.toFixed(2)} (norm ${r.normalized.toFixed(2)})` +
        (lp ? ` surprisal=${lp.surprisal.toFixed(2)}n` : '');
  return (
    `${head} klPrev=${r.klPrev.toFixed(2)} klBase=${r.klBase.toFixed(2)} ` +
    `tokens=${r.tokens}${lp ? ` positions=${lp.positions}` : ''}`
  );
}
