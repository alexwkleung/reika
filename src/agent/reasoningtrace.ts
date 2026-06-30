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
  const words = text.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
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
// is repetitive.
//
// The window must be LARGE: real reasoning spirals recycle whole paragraphs with a period of ~1-2k
// chars, so a small window sees only one copy of each and reads ~0 (measured: a paragraph-recycling
// spiral was 0.10 over a 2400-char window but 0.27 over the full block). A 12k window spans several
// cycles while still reflecting *recent* behavior (so it clears if the model breaks out). The
// threshold is lower than a pure decoder loop (~0.8) because paragraph-recycling sits ~0.27+ early
// and climbs as it cycles; 0.3 catches it after a couple cycles while clearing the ~0.19 healthy
// high-water mark. A false "may be looping" is cheap here (the human just glances), so this leans
// sensitive on purpose.
const SPIN_MIN_CHARS = 1200; // don't judge short thinking
const SPIN_WINDOW = 12000; // trailing window (~3000 tokens) — wide enough to span several spiral cycles
const SPIN_RATIO = 0.3;

// Returns both the verdict and the windowed ratio — the ratio is logged (REIKA_DEBUG) so the
// threshold can be tuned against real values rather than guessed. ratio is 0 for blocks too short
// to judge.
export function liveSpinSignal(reasoning: string): { spinning: boolean; ratio: number } {
  if (reasoning.length < SPIN_MIN_CHARS) return { spinning: false, ratio: 0 };
  const ratio = selfRepeatRatio(reasoning.slice(-SPIN_WINDOW));
  return { spinning: ratio >= SPIN_RATIO, ratio };
}

// Length-aware auto-abort threshold. A pure decoder loop (verbatim, ~0.9) is stuck at any length, so
// require the high bar early. But a LONG block that's only moderately repetitive is also stuck — a
// semantic spiral circles at ~0.4-0.5, far below 0.75, yet a 12k-token block at 0.45 is not healthy
// deliberation. So once a single uninterrupted block grows past any healthy length, lower the bar:
// the length gate is what makes the lower ratio SAFE (it never applies to a normal-length block, and
// genuinely-long DISTINCT reasoning keeps a low ratio and is left alone — that's the discriminator a
// blunt token cap lacks). Returns the ratio a block of this char-length must reach to be auto-cut.
// Tune the curve against the REIKA_DEBUG `verbatim-abort`/`reasoning-spin` ratios on real spirals.
const VERBATIM_LEN_LO = 16000; // ~4000 tokens — above any healthy block; at/below, verbatim-only (0.75)
const VERBATIM_LEN_HI = 28000; // ~7000 tokens — by here a long block needs only moderate repetition
const VERBATIM_RATIO_HI = 0.75; // bar at/below LEN_LO (true decoder loop)
const VERBATIM_RATIO_LO = 0.4; // floor at/above LEN_HI (long + moderately repetitive = stuck)

export function verbatimAbortThreshold(reasoningChars: number): number {
  if (reasoningChars <= VERBATIM_LEN_LO) return VERBATIM_RATIO_HI;
  if (reasoningChars >= VERBATIM_LEN_HI) return VERBATIM_RATIO_LO;
  const t = (reasoningChars - VERBATIM_LEN_LO) / (VERBATIM_LEN_HI - VERBATIM_LEN_LO);
  return VERBATIM_RATIO_HI - t * (VERBATIM_RATIO_HI - VERBATIM_RATIO_LO);
}

// How many recent rounds the cross-round detector compares each new round against (not just the
// immediately prior one). A rumination spiral often echoes a round two or three back while the
// consecutive pair dips below threshold on a paraphrased round — comparing against a small window of
// recent rounds and taking the strongest match catches that echo where a prev-only comparison is
// blind. Kept small: a wider window is more chances to coincidentally overlap, i.e. more false-
// positive surface. k stays at 8 (model-agnostic base rate) — only the comparison span widens.
const REASONING_LOOP_WINDOW = 3;

// Leaky-streak band. A single sub-threshold round must not erase the evidence of a spiral the way a
// hard reset does (observed: a 0.57 round then a 0.33 round zeroed a real loop before it could fire).
// A round whose similarity stays at/above threshold*HOLD is still substantially overlapping — well
// above the ~0.2 healthy 8-gram base rate — so treat it as noise *within* the loop and HOLD the
// streak rather than reset; only a genuinely novel round (below the band) resets. Holding never
// *builds* a streak — only an at-/above-threshold round increments — so this loosens forgetting, not
// the bar to fire.
const STREAK_HOLD_FACTOR = 0.5;

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
// streak of rounds whose reasoning is >= `threshold` similar to any of the last few rounds. A
// sustained streak is rumination — the model re-deriving the same analysis round after round instead
// of converging. This catches a loop the novelty proxy (loop.ts planStaleRounds / seenReadOnly) is
// structurally blind to: in the observed failure the tool *results* looked new each round (so the
// novelty cap kept resetting) while the *reasoning* was byte-identical (crossSim=1.00). Two refinements
// over a naive prev-only/hard-reset detector — both keep k at 8 (model-agnostic), only the comparison
// span and the reset rule change: a small recent-round *window* (REASONING_LOOP_WINDOW) catches a
// spiral that echoes a round two or three back, and a *leaky* streak (STREAK_HOLD_FACTOR) survives a
// single paraphrased dip instead of zeroing on it. selfRepeatRatio is the Layer-1 (intra-stream
// degeneration) signal and is independent of this. See loop.ts for the wiring.
export class ReasoningTrace {
  // Shingle sets of the last REASONING_LOOP_WINDOW rounds, oldest first. Each new round is compared
  // against all of them (max Jaccard); the buffer evicts the oldest once full.
  private window: Set<string>[] = [];
  private streak = 0;
  // The k-grams shared by the current round and its strongest recent match when they were similar
  // enough to count as a loop — i.e. the actual ruminated content. Captured during record() (the
  // Jaccard already finds the intersection) so the last-resort logit recovery can derive bias tokens
  // from what's recurring rather than re-deriving it. Empty whenever the last round broke the streak.
  // See agent/logitrecovery.ts.
  private repeated: string[] = [];

  // Record one round's reasoning (call once per round, in order) and return the strongest similarity
  // vs the last few rounds plus the resulting streak. An empty round (a pure tool-call turn with no
  // thinking) yields sim 0 and resets the streak — conservative, so a momentary gap can't sustain a
  // false loop; the observed loops emit non-empty reasoning every round.
  record(reasoning: string | undefined, threshold: number): { sim: number; streak: number } {
    const text = reasoning ?? '';
    const curSet = new Set(shingles(text));

    // Strongest Jaccard against any round in the window, keeping that round's intersection — the
    // recurring k-grams — for the logit recovery, without a second pass. Comparing against a window
    // (not just the prior round) registers an echo of a round two or three back even when the
    // consecutive pair dipped on a paraphrased round.
    let sim = 0;
    let inter: string[] = [];
    if (curSet.size > 0) {
      for (const prevSet of this.window) {
        if (prevSet.size === 0) continue;
        const shared = [...curSet].filter(s => prevSet.has(s));
        const j = shared.length / (prevSet.size + curSet.size - shared.length);
        if (j > sim) {
          sim = j;
          inter = shared;
        }
      }
    }

    // Leaky streak: increment on a clear match, HOLD through a still-substantially-overlapping round
    // (>= threshold*HOLD) so one paraphrased dip can't zero a real loop, and reset only when the
    // round is genuinely novel. See STREAK_HOLD_FACTOR.
    if (sim >= threshold) this.streak++;
    else if (sim < threshold * STREAK_HOLD_FACTOR) this.streak = 0;
    this.repeated = this.streak > 0 ? inter : [];

    this.window.push(curSet);
    if (this.window.length > REASONING_LOOP_WINDOW) this.window.shift();

    return { sim, streak: this.streak };
  }

  // The recurring k-grams behind the current streak (empty when not looping). The logit recovery
  // mines these for the tokens to down-weight on its one biased round.
  repeatedShingles(): string[] {
    return this.repeated;
  }
}
