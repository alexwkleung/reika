// The status strip's folder path, held on its own line once it wrapped (#948's rule, the TUI's
// `ROW_DWELL_MS`, pinned by a test): the chips beside it change width every second or two (the
// round's timer, the token counts), and a path that hops between lines with them moves the strip's
// height, and the input box above it, each time. It goes to its own line the moment it does not
// fit, and comes back only after it has fit for the whole dwell.
export const PATH_DWELL_MS = 10_000;

export type PathLine = { own: boolean; unfitAt: number };

export const PATH_INLINE: PathLine = { own: false, unfitAt: -Infinity };

export function nextPathLine(prev: PathLine, fits: boolean, now: number): PathLine {
  if (!fits) return { own: true, unfitAt: now };
  if (prev.own && now - prev.unfitAt < PATH_DWELL_MS) return prev;
  return prev.own ? { own: false, unfitAt: prev.unfitAt } : prev;
}

// When a held path may come back, or null when nothing is waiting.
export function pathReturnsAt(line: PathLine): number | null {
  return line.own ? line.unfitAt + PATH_DWELL_MS : null;
}

// Whether the path fits beside the chips: their laid-out width on one line, the strip's gap and the
// path's own text. Measured from the parts rather than read off the layout, because a held path's
// own line says nothing about whether it would fit.
export function pathFits(
  stripWidth: number,
  chipsWidth: number,
  pathWidth: number,
  gap: number,
): boolean {
  return chipsWidth + gap + pathWidth <= stripWidth;
}
