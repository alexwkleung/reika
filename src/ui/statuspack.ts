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
  // When a fresh fit last needed this many rows, and whether the last row is only here on the
  // dwell in `packStatus`, which counts from it.
  neededAt: number;
  dwelling?: boolean;
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

// How long the bar keeps a row nothing needs any more, when the frame before cannot be re-drawn.
// Longer than any chip's come-and-go (a cache chip absent for one round, a shed clearing the gauge),
// so a row that would be back within seconds never leaves.
export const ROW_DWELL_MS = 10_000;

// `lines` with one more break: the last line holding two chips gives up its last one. The tail of
// the bar is the cheapest place to break — everything before it stays where the fit put it.
function spreadByOneLine(lines: Chip[][]): Chip[][] | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length < 2) continue;
    return [...lines.slice(0, i), line.slice(0, -1), line.slice(-1), ...lines.slice(i + 1)];
  }
  return null;
}

// This frame's chips packed with the previous frame's BREAKS kept, which is all that survives: the
// chips' text changes every tick and only their order is fixed. A line the bar has outgrown pushes
// its overflow onto the next one and keeps every other break, so one chip moves instead of the
// whole bar re-flowing. Null when the chip list changed shape under the breaks (a mode switch, the
// PR chip appearing, a shed adding its count), where a break from the old bar means nothing.
function heldBreaks(chips: Chip[], width: number, prev: StatusPack): Chip[][] | null {
  const count = prev.lines.reduce((n, line) => n + line.length, 0);
  if (count !== chips.length) return null;
  const starts = new Set<number>();
  let at = 0;
  for (const line of prev.lines) {
    starts.add(at);
    at += line.length;
  }
  const lines: Chip[][] = [];
  let line: Chip[] = [];
  let used = 0;
  chips.forEach((chip, i) => {
    const w = chipWidth(chip);
    const need = line.length === 0 ? w : used + SEP.length + w;
    if (line.length > 0 && (starts.has(i) || need > width)) {
      lines.push(line);
      line = [chip];
      used = w;
    } else {
      line.push(chip);
      used = need;
    }
  });
  if (line.length > 0) lines.push(line);
  return lines;
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
//
// Breaks cannot be held across a chip that comes or goes (the cache chip on a round that reports no
// count, the gauge after a shed) or a line the bar outgrew, and there the fresh fit used to drop
// the row at once — a row gained and lost a second apart. So a row is also held by COUNT: when the
// fresh fit is one row short of the frame before, it is spread back onto that many rows until the
// row has gone unneeded for `ROW_DWELL_MS`. The clock restarts whenever a fresh fit needs the row,
// so a chip toggling faster than the dwell never moves the bar; one that is gone for good costs the
// row for ten seconds.
export function packStatus(
  chips: Chip[],
  width: number,
  prev?: StatusPack | null,
  now: number = Date.now(),
): StatusPack {
  const fresh = packChips(chips, width);
  const freshRows = countRows(fresh, width);
  if (!prev) return { lines: fresh, rows: freshRows, neededAt: now };
  const held = heldBreaks(chips, width, prev);
  const heldRows = held ? countRows(held, width) : 0;
  // The old breaks cost nothing here, and a fresh fit would move chips between lines for no row
  // saved: a chip that hops up when its neighbour shrinks hops back when it grows.
  if (held && heldRows === freshRows) return { lines: held, rows: heldRows, neededAt: now };
  if (freshRows >= prev.rows) return { lines: fresh, rows: freshRows, neededAt: now };
  const dwell = freshRows === prev.rows - 1 && now - prev.neededAt < ROW_DWELL_MS;
  // A shape the bar fitted itself is held for as long as it can be drawn; one that is only a
  // spread is held for what is left of its dwell.
  if (held && heldRows === freshRows + 1 && heldRows <= prev.rows && (!prev.dwelling || dwell)) {
    return { lines: held, rows: heldRows, neededAt: prev.neededAt, dwelling: prev.dwelling };
  }
  const spread = dwell ? spreadByOneLine(fresh) : null;
  if (spread) {
    return {
      lines: spread,
      rows: countRows(spread, width),
      neededAt: prev.neededAt,
      dwelling: true,
    };
  }
  return { lines: fresh, rows: freshRows, neededAt: now };
}
