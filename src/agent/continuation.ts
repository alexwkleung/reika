// Truncation continuation (#284): when generation is cut off mid-thought, carry the model's own
// work forward instead of discarding it and nudging a restart.
//
// The failure this replaces, measured on a real run: a 30,270-char reasoning block was cut by the
// token limit one clause after solving the problem, the partial was pushed to history where the
// chat template rendered `reasoning_content` as nothing, and the nudge ("continue concisely ... no
// long preamble") read as *start over, briefly*. The model restarted cold and re-ran the same
// `gh issue view` plus two greps — so the same payloads landed in context twice, which is the
// re-fetch → grow → fold cascade of #251/#252. Roughly three hours of work reset to zero.
//
// Three pure pieces, wired in loop.ts:
//   - the ratio gate: is this block worth carrying, or is it degenerate?
//   - the tail: how much of it comes back, cut at a boundary and marked.
//   - the progress ladder: how long may continuing go on without producing anything?
//
// Coherence and burn are deliberately separate knobs. The tail budget decides how much context the
// model gets back; the ladder decides how long it may keep asking for more. A bigger tail does not
// make a runaway more likely — that is the ladder's job — so the two are tuned independently rather
// than traded against each other.

import { crossRoundSimilarity, selfRepeatRatio, verbatimAbortThreshold } from './reasoningtrace.js';

// How much of the cut-off block comes back, in chars. The conclusion of a truncated block sits at
// its END — the model was mid-derivation when the wall hit — so a tail carries the payoff and drops
// the earlier circling by ordering alone, with no classifier needed to separate them. 6000 ≈ 1500
// tokens: on the measured block the resolved answer and its immediate derivation sat in the last
// ~2-3k chars, so this holds it with room to spare. Deliberately generous for calibration — the
// failure mode of a too-small tail (the model lacks the conclusion and restarts) reproduces the
// existing baseline and teaches nothing, while an over-large one re-seeds the rumination and shows
// up as a raised selfRepeatRatio on the continuation round. Only one of those is new information.
// Tighten with data; the carried tail is shed once spent, so this is not a standing window cost.
export const CONTINUATION_TAIL_CHARS = envInt('REIKA_CONTINUE_TAIL_CHARS', 6000);

// A boundary this far into the trimmed window is not worth honoring: a tail whose first blank line
// sits at 90% would lose almost everything to cosmetics. Past this fraction, fall back to a line
// break and then to the raw cut — opening mid-sentence is a smaller harm than dropping the answer.
const BOUNDARY_SEARCH_FRACTION = 0.25;

// Consecutive continuations allowed without progress, where progress is a tool call or a committed
// answer. A count is the wrong unit on its own — it cannot separate a long session that legitimately
// truncates five times from one that truncates five times at the same spot — so this bounds only the
// *unproductive* run and resets the moment the model does something. There is deliberately no
// ceiling on how many times a session may continue in total.
export const MAX_CONSECUTIVE_CONTINUATIONS = envInt('REIKA_CONTINUE_MAX', 3);

// Jaccard bar above which a continuation is not continuing but repeating. Sits well above the ~0.2
// healthy 8-gram base rate noted in reasoningtrace.ts: a continuation legitimately shares vocabulary
// and subject matter with the round it resumes, so only a near-restatement should count. This is the
// novelty half of the ladder — a model that keeps producing fresh text is still working, however many
// continuations that takes, while one restating itself is stopped regardless of the count.
export const CONTINUATION_NOVELTY_LIMIT = 0.8;

// 0 is a real setting for both knobs, not an unset: REIKA_CONTINUE_MAX=0 carries the tail but spends
// no continuation, and REIKA_CONTINUE_TAIL_CHARS=0 is the nudge-only ablation — the arm that says
// whether the win came from the carried text or from the rewritten nudge. A knob that reads as
// disabled and silently runs at the default would misattribute the run it was set for.
function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// Marker for the trimmed head, in reika's voice so it can't be mistaken for the model's own text.
// States what was dropped AND that what remains is the most recent working — the omitted part is
// superseded, not a gap to reconstruct, and saying so keeps an over-thinking model from auditing it.
export function continuationMarker(omitted: number): string {
  return (
    `[reika: ${omitted} chars of your earlier reasoning trimmed to fit — ` +
    `what follows is your most recent working]`
  );
}

// Is this cut-off block worth carrying forward, or is it degenerate?
//
// The discriminator is the repetition ratio, NOT which cut fired. Two different cuts can end the
// same round — the max_tokens wall and REASONING_HARD_CEIL — and on the measured run they were 5.4%
// apart (30,270 chars against a 32,000 ceiling), so which one landed first was near-arbitrary. They
// cannot be allowed to carry opposite semantics (carry the work vs. discard it as degenerate) when
// they are that close to coin-flip neighbors.
//
// `verbatimAbortThreshold` is reused rather than given its own curve. It is calibrated against 84
// real blocks and is the right shape, but it was tuned for "should I cut this stream?" — a different
// question from "is this worth keeping?", with different error costs. Both the ratio and the verdict
// are returned so the caller can log them on every event and a continuation-specific bar can be
// derived from real data rather than guessed now. Known compromise; see the issue.
export function continuationGate(reasoning: string): {
  continuable: boolean;
  ratio: number;
  threshold: number;
} {
  const ratio = selfRepeatRatio(reasoning);
  // Infinity under 2000 chars — too short to judge, so nothing is ever called degenerate on it.
  const threshold = verbatimAbortThreshold(reasoning.length);
  return { continuable: ratio < threshold, ratio, threshold };
}

// The slice of the cut-off block that comes back, with the trimmed head marked.
//
// Cuts at a boundary so the carried text does not OPEN mid-sentence; it still ENDS mid-sentence,
// which is the point — that is the exact resume anchor the nudge refers to. Returns the text
// unchanged (and omitted 0) when it already fits, so a short truncated block carries verbatim.
export function continuationTail(
  text: string,
  budget: number = CONTINUATION_TAIL_CHARS,
): { text: string; omitted: number } {
  if (text.length <= budget) return { text, omitted: 0 };
  // The nudge-only arm (budget 0): the model is told its work was cut and asked to resume from it,
  // with none of it carried. Guarded explicitly because `slice(-0)` is `slice(0)` — the whole string,
  // i.e. a budget of zero would otherwise carry everything.
  if (budget <= 0) return { text: continuationMarker(text.length), omitted: text.length };

  const window = text.slice(-budget);
  const limit = Math.floor(budget * BOUNDARY_SEARCH_FRACTION);
  // Prefer a paragraph break, then a line break, then accept the raw cut. Each candidate is honored
  // only if it lands early in the window (see BOUNDARY_SEARCH_FRACTION) — a boundary deep in the
  // tail would trade the answer for a tidy opening.
  const para = window.indexOf('\n\n');
  const line = window.indexOf('\n');
  let start = 0;
  if (para >= 0 && para <= limit) start = para + 2;
  else if (line >= 0 && line <= limit) start = line + 1;

  const body = window.slice(start);
  const omitted = text.length - body.length;
  return { text: `${continuationMarker(omitted)}\n\n${body}`, omitted };
}

// The burn control: how long may continuing go on without producing anything?
//
// Two independent stops, either of which ends the run of continuations:
//   - count  — MAX_CONSECUTIVE_CONTINUATIONS in a row with no tool call and no committed answer.
//   - novelty — a continuation that merely restates the previous one is not continuing.
//
// `noteProgress` resets both, so the bound is on unproductive continuation rather than on
// continuation itself. Mirrors the existing `lengthRetries = 0` discipline in loop.ts, with a
// meaningful predicate in place of "any successful round".
export class ContinuationGate {
  private consecutive = 0;
  private lastText = '';

  // May another continuation be spent?
  //
  // `reasoning` must be the round's NEWLY GENERATED text, never the carried tail. A continuation's
  // tail contains the round it resumes, so comparing accumulated text against accumulated text
  // reports near-1 similarity by construction and would refuse every second continuation — the same
  // self-trigger the Layer-2 detector falls into when a split round is recorded as two entries.
  // Compared against the previous continuation's new text, a restatement is refused even when the
  // count still allows it.
  allow(reasoning: string): { ok: boolean; reason?: 'count' | 'novelty'; sim: number } {
    const sim = this.lastText ? crossRoundSimilarity(this.lastText, reasoning) : 0;
    if (this.consecutive >= MAX_CONSECUTIVE_CONTINUATIONS)
      return { ok: false, reason: 'count', sim };
    if (sim >= CONTINUATION_NOVELTY_LIMIT) return { ok: false, reason: 'novelty', sim };
    return { ok: true, sim };
  }

  // A continuation was spent on this block.
  noteContinuation(reasoning: string): void {
    this.consecutive++;
    this.lastText = reasoning;
  }

  // The model produced a tool call or committed an answer — the run of unproductive continuations is
  // over, and the next truncation starts from a clean budget.
  noteProgress(): void {
    this.consecutive = 0;
    this.lastText = '';
  }

  // For the debug line: how many continuations have been spent without progress.
  get spent(): number {
    return this.consecutive;
  }
}
