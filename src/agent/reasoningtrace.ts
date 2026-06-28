// Debug-only diagnostics that classify a round's reasoning by failure mode, so a single looping
// run reveals which thinking-block loop dominates before either loop-breaker is built:
//   - Layer 1 (verbatim degeneration): a sampling loop re-emitting the same span within ONE stream.
//     Signature: high selfRepeatRatio, usually with finishReason=length.
//   - Layer 2 (cross-round rumination): semantically circular reasoning that never converges.
//     Signature: high crossRoundSimilarity across consecutive rounds with no edit/finalization,
//     while selfRepeatRatio stays low (each round is fresh-ish prose, just going in circles).
// Model-invisible — only the REIKA_DEBUG log consumes these. Pure + tested so the thresholds can be
// calibrated against real transcripts. See loop.ts (the wiring) and the reasoning-loop work notes.

// Shingle text into word-level k-grams for set comparison. Word-level (not char) so trivial
// whitespace/tokenization differences don't mask a real repeat; k=8 is long enough that healthy
// prose rarely repeats an 8-gram verbatim, so a high ratio is signal, not base rate.
const SHINGLE_K = 8;

function shingles(text: string, k = SHINGLE_K): string[] {
  const words = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length < k) return [];
  const out: string[] = [];
  for (let i = 0; i + k <= words.length; i++) out.push(words.slice(i, i + k).join(' '));
  return out;
}

// Fraction of this text's k-grams that duplicate an earlier k-gram in the SAME text. ~0 for healthy
// reasoning; climbs toward 1 as a single stream degenerates into a repeated span (Layer 1). Returns
// 0 for text too short to shingle (nothing to conclude from).
export function selfRepeatRatio(text: string): number {
  const sh = shingles(text);
  if (sh.length === 0) return 0;
  const seen = new Set<string>();
  let dup = 0;
  for (const s of sh) {
    if (seen.has(s)) dup++;
    else seen.add(s);
  }
  return dup / sh.length;
}

// Live "is this reasoning block spinning?" heuristic for the human-in-the-loop UI hint — NOT an
// automated abort. Mid-stream we can't know whether a model will escape a *semantic* spiral, so we
// don't guess and cut; we surface a soft signal and let the human (who can glance at the thinking)
// decide to abort or wait. True only when the block is long enough to judge AND its trailing window
// is verbatim-repetitive. Tuned to flag clear churn without crying wolf: healthy long reasoning
// measured ~0.2 self-repeat over a whole block, so 0.5 over a trailing window has clear headroom.
const SPIN_MIN_CHARS = 1200; // don't judge short thinking
const SPIN_WINDOW = 2400; // trailing window (~600 tokens) — local repetition, not the whole block
const SPIN_RATIO = 0.5;

export function liveSpinSignal(reasoning: string): boolean {
  if (reasoning.length < SPIN_MIN_CHARS) return false;
  return selfRepeatRatio(reasoning.slice(-SPIN_WINDOW)) >= SPIN_RATIO;
}

// Jaccard overlap of k-grams between two rounds' reasoning. High across consecutive rounds (with no
// progress) means the model is re-deriving the same analysis instead of converging (Layer 2). 0 when
// either side is too short to shingle.
export function crossRoundSimilarity(a: string, b: string): number {
  const sa = new Set(shingles(a));
  const sb = new Set(shingles(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// Stateful Layer-2 detector: records each round's reasoning in order and tracks the consecutive
// streak of rounds whose reasoning is >= `threshold` similar to the prior round. A sustained streak
// is rumination — the model re-deriving the same analysis round after round instead of converging.
// This catches a loop the novelty proxy (loop.ts planStaleRounds / seenReadOnly) is structurally
// blind to: in the observed failure the tool *results* looked new each round (so the novelty cap kept
// resetting) while the *reasoning* was byte-identical (crossSim=1.00). selfRepeatRatio is the Layer-1
// (intra-stream degeneration) signal and is independent of this. See loop.ts for the wiring.
export class ReasoningTrace {
  private prev: string | undefined;
  private streak = 0;

  // Record one round's reasoning (call once per round, in order) and return the similarity vs the
  // previous round plus the resulting consecutive-high streak. An empty round (a pure tool-call turn
  // with no thinking) yields sim 0 and resets the streak — conservative, so a momentary gap can't
  // sustain a false loop; the observed loops emit non-empty reasoning every round.
  record(reasoning: string | undefined, threshold: number): { sim: number; streak: number } {
    const text = reasoning ?? '';
    const sim = this.prev !== undefined ? crossRoundSimilarity(this.prev, text) : 0;
    this.streak = sim >= threshold ? this.streak + 1 : 0;
    this.prev = text;
    return { sim, streak: this.streak };
  }
}
