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

// The distinct k-grams that recur within a single block — the span a verbatim (Layer-1) spiral is
// re-emitting. Layer-1 analogue of ReasoningTrace.repeatedShingles (which is cross-round). The logit
// recovery mines these for bias tokens when a degenerate block is being discarded at verbatim-abort
// time. Empty for text too short to shingle (nothing repeats).
export function repeatedSelfShingles(text: string): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const s of shingles(text)) {
    if (seen.has(s)) repeated.add(s);
    else seen.add(s);
  }
  return [...repeated];
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
// Below this there is not enough text to conclude anything: a 400-char block that says one sentence
// twice scores high without being stuck. No ratio-based abort under it — the hard ceil still applies.
const VERBATIM_LEN_MIN = 2000;
const VERBATIM_LEN_LO = 16000; // ~4000 tokens — the length past which even moderate repetition is odd
const VERBATIM_LEN_HI = 28000; // ~7000 tokens — by here a long block needs only moderate repetition
// The bars were 0.75/0.4, on the theory that a sub-LEN_LO block only needs protection from a true
// byte-verbatim decoder loop. Measured against 84 reasoning blocks >=1500 chars over 30 saved
// sessions (60 `/review`, 24 general), that left a hole a *semantic* loop walks straight through:
//
//   healthy: median 0.001, p90 0.020, p99 0.082, MAX 0.120 (a 2435c general block)
//   observed loop: 0.549 at 4001 chars — one generation repeating a paragraph four times
//
// At 4001 chars the old bar was 0.75, so nothing cut it; the model would have had to reach ~24000
// chars before the descending curve caught up with its ratio. Every bar in 0.25-0.50 separates that
// loop from all 83 healthy blocks, so these sit mid-band: ~3x margin over the worst healthy block,
// ~0.2 under the observed loop. The long end is thinner: 4 healthy blocks past LEN_LO and 1 past
// LEN_HI (28872 chars, ratio 0.009), all far under the floor — enough to say the floor is not
// obviously wrong, not enough to have tuned it. Re-measure before moving any of them (the corpus is
// one model); evals/selfrepeat-report.ts is the instrument, and the numbers here are the whole
// argument for the values.
const VERBATIM_RATIO_HI = 0.35; // bar between LEN_MIN and LEN_LO
const VERBATIM_RATIO_LO = 0.25; // floor at/above LEN_HI (long + moderately repetitive = stuck)

export function verbatimAbortThreshold(reasoningChars: number): number {
  // Unreachable rather than 1.0: a ratio can BE 1.0 on a pathological short block, and this must
  // read as "no ratio abort here", not "abort only on a perfect repeat".
  if (reasoningChars < VERBATIM_LEN_MIN) return Number.POSITIVE_INFINITY;
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
  // Which channel this turn's comparisons are drawn from. Chosen on the first round that carries any
  // text and sticky afterwards: a Jaccard between one round's reasoning and another's content
  // compares two different distributions and means nothing, so the window must hold one channel's
  // shingles only. Same reason entropytrace.ts keeps logprobs out of its KL columns.
  private channel?: 'reasoning' | 'content';
  // The k-grams shared by the current round and its strongest recent match when they were similar
  // enough to count as a loop — i.e. the actual ruminated content. Captured during record() (the
  // Jaccard already finds the intersection) so the last-resort logit recovery can derive bias tokens
  // from what's recurring rather than re-deriving it. Empty whenever the last round broke the streak.
  // See agent/logitrecovery.ts.
  private repeated: string[] = [];

  // Record one round (call once per round, in order) and return the strongest similarity vs the last
  // few rounds, the resulting streak, and which channel produced them. An empty round (a pure
  // tool-call turn with no thinking) yields sim 0 and resets the streak — conservative, so a
  // momentary gap can't sustain a false loop; the observed loops emit non-empty reasoning every round.
  record(
    round: { reasoning?: string; content?: string },
    threshold: number,
  ): { sim: number; streak: number; channel: 'reasoning' | 'content' } {
    const reasoning = round.reasoning ?? '';
    const content = round.content ?? '';

    // Pick the channel. Reasoning wins whenever the model emits any: it is what the thresholds were
    // calibrated against, and on a thinking model the content channel is mostly tool-call scaffolding.
    // Content is the fallback for a model with NO reasoning channel — a non-thinking model, or one
    // whose reasoning the dialect handling strips — which otherwise gets zero Layer-2 coverage,
    // since `reasoning` is empty every round and the streak resets forever.
    if (reasoning) {
      // Reasoning arriving after a content-seeded window invalidates that window: the shingles in it
      // came from a different channel and aren't comparable. Restart rather than report a bogus sim.
      if (this.channel === 'content') {
        this.window = [];
        this.streak = 0;
        this.repeated = [];
      }
      this.channel = 'reasoning';
    } else if (!this.channel && content) {
      this.channel = 'content';
    }

    const text = this.channel === 'content' ? content : reasoning;
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

    return { sim, streak: this.streak, channel: this.channel ?? 'reasoning' };
  }

  // The recurring k-grams behind the current streak (empty when not looping). The logit recovery
  // mines these for the tokens to down-weight on its one biased round.
  repeatedShingles(): string[] {
    return this.repeated;
  }
}
