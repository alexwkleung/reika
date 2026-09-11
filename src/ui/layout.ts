import wrapAnsi from 'wrap-ansi';

// How wide a block actually is, in columns.
//
// Ink lays a <Static> row out at its INTRINSIC width, not the terminal's: a Box in row direction
// hands each child the width it asks for and lets the row overflow. A column of <Text> wraps
// (the child inherits the parent's width), which is why most of the scrollback behaves — but a
// label-and-value row (`cwd:  <path>`, the header line) does not, and a long value runs off the
// edge for the TERMINAL to wrap, mid-token, with no hanging indent. Giving the row an explicit
// width is what puts the wrap back under Ink's control.
//
// `indent` is any margin the block sits behind (the diff view's marginLeft, a nested subagent
// block), which the block's own layout has to pay for out of the same columns.
export function contentWidth(indent = 0): number {
  // The App renders everything inside paddingX={1}, so two columns are gone before any block
  // starts. The floor keeps a pathologically narrow terminal from producing a zero-width layout.
  return Math.max(20, (process.stdout.columns || 80) - 2 - indent);
}

// Wrap `text` so that a marker-prefixed line ("  ↳ Ran: …", "$ …", "⏺︎ Bash(…)") keeps a HANGING
// INDENT: every row after the first lands under the text, not back at column 0.
//
// Ink has no hanging indent. A marker and its text share one <Text> (they must — adjacent <Text>
// siblings in a row Box lose the boundary character when the line wraps), so Ink wraps the whole
// string at the block's left edge and the continuation row starts flush left, visually detached
// from the line it belongs to (issue #167). Pre-wrapping here and injecting the indent ourselves
// puts every row where it belongs; Ink's own re-wrap is then a no-op because each row already fits.
//
// `width` is the block's full width including the marker. `hang` is the marker's width, which
// every continuation row is indented by. `first` is how many columns are already spent on the
// first row when the marker is not a fixed-width prefix (`⏺︎ Bash` before its args) — it defaults
// to `hang`, the fixed-marker case.
export function hangingWrap(text: string, width: number, hang: number, first = hang): string {
  const pad = ' '.repeat(hang);
  // wrap-ansi takes one width for the whole string, so a wider first prefix is paid for with
  // filler that is sliced back off after wrapping.
  const lead = ' '.repeat(Math.max(0, first - hang));
  const wrapAt = Math.max(1, width - hang);
  const out: string[] = [];
  let atStart = true;
  for (const line of text.split('\n')) {
    const rows = wrapAnsi(atStart ? lead + line : line, wrapAt, {
      // Ink's own options (build/wrap-text.js), so the break points match what Ink would have
      // chosen and this stays a re-formatting of Ink's wrap rather than a second, different one.
      trim: false,
      hard: true,
    }).split('\n');
    rows.forEach((row, i) => {
      // trim:false leaves the whitespace wrap-ansi broke on at the head of the continuation row —
      // the whole run of it, so a line that breaks inside expanded tabs staggers further right on
      // every row. Under an indent that is pure noise, so drop it. Only for rows the wrap produced
      // (i > 0): leading whitespace after a REAL newline is content (indented code, tree output).
      const body = i === 0 ? row : row.replace(/^ +/, '');
      if (atStart) {
        out.push(body.slice(lead.length));
        atStart = false;
      } else {
        // A row that was nothing but wrap whitespace leaves the pad alone; emit it empty rather
        // than as trailing spaces, which carry real width and can push a row into a wrap.
        out.push(body ? pad + body : '');
      }
    });
  }
  return out.join('\n');
}
