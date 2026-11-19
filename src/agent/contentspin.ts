// Content-channel spin gate (#944): the reasoning cuts never see a loop in the visible output. Why
// the bar is stricter than reasoning's, and the replay to re-run before moving it: AGENTS.md.
import { selfRepeatRatio } from './reasoningtrace.js';

// Below this the gate judges nothing: too short to conclude a repeat from, and the round is not
// expensive enough to be worth a wrong cut. Also the length at which the observed loops were
// already obvious.
export const CONTENT_SPIN_MIN_CHARS = 16000;

// Near-verbatim only. See AGENTS.md: content is the deliverable, and structure repeats legitimately.
export const CONTENT_SPIN_RATIO = 0.8;

// Re-scan cadence, in new content chars. Coarser than the reasoning debounce (400) because the
// windows are much larger and the verdict cannot flip on a few hundred chars: past 16000 chars, an
// extra 2000 of a repeat is cheap to pay for skipping ~8 window scans.
export const CONTENT_SPIN_DEBOUNCE = 2000;

// Trailing window scales, tried in order; the strongest ratio wins (see AGENTS.md). The smallest is
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

// The openers of the in-band call dialects client.ts parses out of content. A model with no native
// tool template streams its call's arguments here, and a write of a repetitive file is a repeat the
// gate must not cut, so judging stops where the first call opens.
const INBAND_CALL_OPENER = /<tool_call>|<function=/;

export function textBeforeInbandCall(content: string): string {
  const at = content.search(INBAND_CALL_OPENER);
  return at === -1 ? content : content.slice(0, at);
}

// Judge an in-flight content stream. Cheap enough to call on the loop's debounce: the windows are
// clamped to what the reply actually holds, so a check costs one pass over at most 64k chars.
export function contentSpinSignal(raw: string): ContentSpinReading {
  const content = textBeforeInbandCall(raw);
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
