// Content-channel spin gate (#944). The live loop's other cut reads the REASONING stream only
// (reasoningtrace.ts liveSpinSignal / verbatimAbortThreshold), so a reply that degenerates in its
// visible output runs to max_tokens and only then takes the length retry. On slow local decode that
// is the whole window spent on text nobody can use: measured in two saved sessions, ~24k chars of
// "let me re-read the task…" written into `content` (thinking that leaked into the output channel,
// so the reasoning detectors never saw it) and ~37k chars of one code block re-emitted.
//
// The bar here is deliberately NOT the reasoning bar. The two channels cost different things when
// the gate is wrong. A wrong cut on reasoning throws away a thought and the model recovers from its
// findings; a wrong cut on CONTENT throws away the deliverable — an answer or a code block the user
// asked for. And repetitive output is not automatically wrong output: tables, generated fixtures,
// numbered lists with a fixed shape and switch-heavy code all repeat by construction. So:
//
//   - ratio >= 0.8, near-verbatim only. Of the five saved replies long enough to judge, the two
//     content loops scored 0.88 and 0.83 and the other three 0.027, 0.001 and 0.001. The reasoning
//     curve's descent toward 0.25 (verbatimAbortThreshold) is far too loose here — that band is full
//     of legitimate structure.
//   - only past CONTENT_SPIN_MIN_CHARS. Below ~16k chars a high ratio is cheap to reach by accident
//     (one paragraph said twice), and it is not a cost worth measuring: the round is short anyway.
//   - NO absolute length ceiling, unlike REASONING_HARD_CEIL. Long output is not evidence of a loop;
//     a 100k-char answer of distinct text keeps a low ratio and is left alone. max_tokens already
//     bounds the length, and this gate exists to stop paying for the repetition, not the volume.
//
// The trailing window is what makes it a recovery and not a death sentence: the ratio is measured
// over the most recent slice only, so a model that breaks out of the repeat clears it. Several
// window lengths are tried and the strongest ratio wins, because a repeat has a period and a window
// narrower than a few periods reads low (a 10k block repeated twice in 20k is a loop, but a
// 16k-only window sees 1.5 copies and scores ~0.5). WINDOWS tops out at 64k, which spans repeats
// with a period up to ~12k at the 0.8 bar.
//
// Measured with evals/contentspin-replay.ts over the saved corpus — the replay walks every assistant
// content block through this exact function, stepping the gate the way the stream does, so it
// reports the false-positive rate a threshold change would buy. Re-run it before moving either
// number.
import { selfRepeatRatio } from './reasoningtrace.js';

// Below this the gate judges nothing: too short to conclude a repeat from, and the round is not
// expensive enough to be worth a wrong cut. Also the length at which the observed loops were
// already obvious.
export const CONTENT_SPIN_MIN_CHARS = 16000;

// Near-verbatim only. See the header: content is the deliverable, and structure repeats legitimately.
export const CONTENT_SPIN_RATIO = 0.8;

// Re-scan cadence, in new content chars. Coarser than the reasoning debounce (400) because the
// windows are much larger and the verdict cannot flip on a few hundred chars: past 16000 chars, an
// extra 2000 of a repeat is cheap to pay for skipping ~8 window scans.
export const CONTENT_SPIN_DEBOUNCE = 2000;

// Trailing window scales, tried in order; the strongest ratio wins (see the header). The smallest is
// the minimum judged length, so a check below it has nothing to look at anyway.
const CONTENT_SPIN_WINDOWS = [CONTENT_SPIN_MIN_CHARS, 32000, 64000];

export type ContentSpinReading = {
  // Whether the gate would cut. False below CONTENT_SPIN_MIN_CHARS regardless of ratio.
  spinning: boolean;
  // Strongest duplicate-shingle fraction across the trailing windows; 0 when unjudged (too short).
  ratio: number;
  // The window that produced `ratio`; 0 when unjudged.
  window: number;
  // Total content chars fed in, so the log line says how far into the reply the verdict landed.
  chars: number;
  // Whether the tail sits inside an open code fence. Measurement only — the gate does not treat a
  // fence differently, because the observed code-block loop (case 2) would be missed by skipping,
  // and "stricter inside a fence" is a threshold change with no corpus behind it yet. Recorded on
  // every logged check so that question can be answered from real runs instead of guessed.
  fence: boolean;
};

// Is the END of `text` inside an unclosed code fence? A closer is the opener's character, at least
// as long, and bare (a `~~~` line with an info string opens, it does not close) — the CommonMark
// rule, and the same one ui/markdown.ts openFenceBefore applies to the live tail. Reimplemented
// rather than imported: that module is the renderer and pulls in chalk/marked, which the loop must
// not depend on.
export function fenceOpenAtTail(text: string): boolean {
  let open: string | null = null;
  for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const fence = m[1];
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && !m[2].trim()) open = null;
  }
  return open !== null;
}

// Judge an in-flight content stream. Cheap enough to call on the loop's debounce: the windows are
// clamped to what the reply actually holds, so a check costs one pass over at most 64k chars.
export function contentSpinSignal(content: string): ContentSpinReading {
  const chars = content.length;
  if (chars < CONTENT_SPIN_MIN_CHARS)
    return { spinning: false, ratio: 0, window: 0, chars, fence: false };
  let ratio = 0;
  let window = 0;
  for (const w of CONTENT_SPIN_WINDOWS) {
    const r = selfRepeatRatio(content.slice(-w));
    if (r > ratio) {
      ratio = r;
      // The effective window, not the scale: below 64k chars the wider scales all read the same
      // slice, and a log line claiming a 64k window over a 20k reply cannot be reconstructed.
      window = Math.min(w, chars);
    }
  }
  return {
    spinning: ratio >= CONTENT_SPIN_RATIO,
    ratio,
    window,
    chars,
    fence: fenceOpenAtTail(content),
  };
}
