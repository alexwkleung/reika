import stringWidth from 'string-width';

// A segment is one run of text carrying one look. `underline` is the only attribute a segment
// carries beyond its hue — the link underline, which promises a click and so is set only where the
// terminal can deliver one (see `prChip` in Status.tsx).
export type Segment = { text: string; color: string; underline?: boolean };

// A chip is the unit the status line wraps at — a name and its value, never split across lines.
export type Chip = Segment[];

// Between two chips on one line. Exported so the row count and the drawn rows pay for it the same.
export const SEP = ' · ';

export function chipWidth(chip: Chip): number {
  return chip.reduce((n, seg) => n + stringWidth(seg.text), 0);
}

// Greedy first-fit: chips go on the current line while they fit (separator included), and the
// first one that doesn't starts the next. Chips never split, and the separator never leads or
// trails a line — a continuation row starts on its chip, like a wrapped list. A chip wider than
// the whole width still gets a line of its own; the overflow is Ink's to wrap.
export function packChips(chips: Chip[], width: number): Chip[][] {
  const lines: Chip[][] = [];
  let line: Chip[] = [];
  let used = 0;
  for (const chip of chips) {
    const w = chipWidth(chip);
    const need = line.length === 0 ? w : used + SEP.length + w;
    if (line.length > 0 && need > width) {
      lines.push(line);
      line = [chip];
      used = w;
    } else {
      line.push(chip);
      used = need;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

export type StatusPack = {
  // The lines to draw, and the display rows they take: a chip wider than the whole pane is one line
  // here and several rows on screen, which is what `rows` pays for and what App budgets the frame
  // with.
  lines: Chip[][];
  rows: number;
};

// Display rows `lines` take at `width`: one per line, except a chip the pane can't hold whole,
// which Ink hard-wraps onto as many rows as it needs.
function countRows(lines: Chip[][], width: number): number {
  const cols = Math.max(1, width);
  return lines.reduce((n, line) => {
    const w = line.reduce((sum, chip) => sum + chipWidth(chip), 0) + SEP.length * (line.length - 1);
    return n + Math.max(1, Math.ceil(w / cols));
  }, 0);
}

function pack(lines: Chip[][], width: number): StatusPack {
  return { lines, rows: countRows(lines, width) };
}

// The bar's lines as the previous frame drew them, re-measured against the chips of this one — the
// same BREAKS, which is all that survives: the chips' text changes every tick and only their order
// is fixed. Null when those breaks can no longer be drawn: a line the bar has outgrown, or a chip
// list that changed shape under them (a mode switch, the PR chip appearing, a shed adding its
// count), where a break from the old bar means nothing.
function heldBreaks(chips: Chip[], width: number, prev: StatusPack): Chip[][] | null {
  const lines: Chip[][] = [];
  let at = 0;
  for (const line of prev.lines) {
    const next: Chip[] = [];
    let used = 0;
    for (let n = 0; n < line.length; n++, at++) {
      const chip = chips[at];
      if (!chip) return null;
      const w = chipWidth(chip);
      used = next.length === 0 ? w : used + SEP.length + w;
      if (used > width) return null;
      next.push(chip);
    }
    if (next.length > 0) lines.push(next);
  }
  return at === chips.length ? lines : null;
}

// The status bar's packing (#948).
//
// `packChips` is a pure re-fit, and the bar is re-fitted on every render — which on a narrow pane
// means one re-fit a tick for the whole of a turn, because the chips' text is volatile: a round's
// timer runs `0s` → `1m 09s` and resets at the next one, and the token counts gain a character as
// they cross a digit. Every gain and loss of a column can be enough to move the bar's last row, and
// a row that comes and goes moves the live region and the input box with it — the flicker at the
// bottom of the screen (#948).
//
// So the bar keeps the row it already has: when a fresh fit comes out SHORTER than the frame before,
// the breaks of that frame are kept instead, as long as they can still be drawn. Nothing else is
// carried between frames — no latched width, no chip identities — because the breaks re-measure
// themselves against this frame's chips and hold only while the bar could actually have drawn them.
//
// The hold is bounded, so the bar can never drift away from the pane it is drawn on:
//
// - One row, at most. When the bar shrinks far enough that keeping its shape would cost two rows
//   more than a fresh fit, the shape is given up rather than held: an extra row is worth a re-fit,
//   a permanently ragged bar is not.
// - It is not a ratchet. The hold is the previous frame's shape, not a separate preference, so it
//   ends the moment the bar outgrows one of those lines — which growing chips do within a few ticks
//   — and the next frame is fitted fresh.
// - A resize that makes the bar fit into fewer rows gives the held shape up by the same rule.
export function packStatus(chips: Chip[], width: number, prev?: StatusPack | null): StatusPack {
  const fresh = packChips(chips, width);
  if (!prev) return pack(fresh, width);
  const held = heldBreaks(chips, width, prev);
  if (!held || held.length <= fresh.length || held.length > fresh.length + 1) {
    return pack(fresh, width);
  }
  return pack(held, width);
}
