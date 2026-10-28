import { useEffect, useState } from 'react';
import wrapAnsi from 'wrap-ansi';

// How wide a block actually is, in columns.
//
// Ink lays a <Static> row out at its INTRINSIC width, not the terminal's: a Box in row direction
// hands each child the width it asks for and lets the row overflow. A column of <Text> wraps
// (the child inherits the parent's width), which is why most of the scrollback behaves — but a
// label-and-value row (the splash's `cwd:  <path>`) does not, and a long value runs off the
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

// `contentWidth()` that follows the terminal. Ink re-lays its yoga tree on a resize but does not
// re-run components, so a component that packs its own lines off `process.stdout.columns` keeps
// the old width until something else re-renders it — when idle, that's never. Subscribing to the
// resize event is what makes the packing responsive.
export function useContentWidth(indent = 0): number {
  const [width, setWidth] = useState(() => contentWidth(indent));
  useEffect(() => {
    const onResize = () => setWidth(contentWidth(indent));
    onResize();
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, [indent]);
  return width;
}

// Display rows `text` takes at `width` columns — the unit Ink measures a frame in when it decides
// the frame is as tall as the viewport. Wrapped with the exact options Ink wraps with
// (build/wrap-text.js), so a row count measured here is the row count that gets drawn.
export function wrappedRows(text: string, width: number): number {
  return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true }).split('\n').length;
}

// Wrap styled text into rows that each carry every style active where they start (#852).
//
// wrap-ansi re-opens only ONE code at a break — the last it saw — so stacked styles lose all but
// the innermost: a comment is gray then italic, and its continuation rows came back italic in the
// default foreground; a changed word in a diff is a background then a foreground, and lost its
// highlight the same way. So the state at each row's end is replayed at the next row's start, and
// closed at the row's end so a row never leaks a style into whatever Ink draws after it. Same
// options as Ink's own wrap, so the break points and row count are unchanged.
export function wrapStyledRows(text: string, width: number): string[] {
  const rows = wrapAnsi(text, Math.max(1, width), { trim: false, hard: true }).split('\n');
  let open = new Map<SgrSlot, string>();
  return rows.map(row => {
    const lead = [...open.values()].join('');
    open = sgrStateAfter(row, open);
    const close = [...open.keys()].map(slot => SGR_CLOSE[slot]).join('');
    return lead + row + close;
  });
}

// The styled text whose plain characters are `[start, end)`, opening with the styles active at
// `start` and closing what is still open at `end`, so the slice stands on its own. Lets a caller
// style a whole line in one pass and cut it afterwards: a fragment styled alone loses its context,
// as a run of words from the middle of a comment does without the `//` that made it one (#852).
export function sliceStyled(text: string, start: number, end: number): string {
  const sgr = /\x1b\[[0-9;]*m/y;
  let open = new Map<SgrSlot, string>();
  let out = '';
  let plain = 0;
  let i = 0;
  while (i < text.length && plain < end) {
    sgr.lastIndex = i;
    const code = sgr.exec(text);
    if (code) {
      if (plain < start) open = sgrStateAfter(code[0], open);
      else out += code[0];
      i += code[0].length;
      continue;
    }
    if (plain === start) out = [...open.values()].join('') + out;
    if (plain >= start) out += text[i];
    plain++;
    i++;
  }
  const after = sgrStateAfter(out, new Map());
  return out + [...after.keys()].map(slot => SGR_CLOSE[slot]).join('');
}

type SgrSlot = 'fg' | 'bg' | 'weight' | 'italic' | 'underline' | 'inverse' | 'strike';
const SGR_CLOSE: Record<SgrSlot, string> = {
  fg: '\x1b[39m',
  bg: '\x1b[49m',
  weight: '\x1b[22m',
  italic: '\x1b[23m',
  underline: '\x1b[24m',
  inverse: '\x1b[27m',
  strike: '\x1b[29m',
};
const SIMPLE_SLOTS: Record<number, [SgrSlot, boolean]> = {
  1: ['weight', true],
  2: ['weight', true],
  3: ['italic', true],
  4: ['underline', true],
  7: ['inverse', true],
  9: ['strike', true],
  22: ['weight', false],
  23: ['italic', false],
  24: ['underline', false],
  27: ['inverse', false],
  29: ['strike', false],
  39: ['fg', false],
  49: ['bg', false],
};

// Which styles are open after `row`, starting from `before`. Each open slot holds the sequence that
// re-opens it; a compound sequence (`38;2;r;g;b`) is split into its own per-slot sequence.
function sgrStateAfter(row: string, before: Map<SgrSlot, string>): Map<SgrSlot, string> {
  const state = new Map(before);
  for (const match of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = match[1] === '' ? [0] : match[1].split(';').map(Number);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        state.clear();
      } else if (p === 38 || p === 48) {
        // 38;5;n and 38;2;r;g;b carry their color in the params that follow.
        const span = params[i + 1] === 5 ? 2 : params[i + 1] === 2 ? 4 : 0;
        const code = params.slice(i, i + 1 + span).join(';');
        state.set(p === 38 ? 'fg' : 'bg', `\x1b[${code}m`);
        i += span;
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        state.set('fg', `\x1b[${p}m`);
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        state.set('bg', `\x1b[${p}m`);
      } else if (SIMPLE_SLOTS[p]) {
        const [slot, opens] = SIMPLE_SLOTS[p];
        if (opens) state.set(slot, `\x1b[${p}m`);
        else state.delete(slot);
      }
    }
  }
  return state;
}

// `hangingWrap`'s row count for the same text at the same width.
export function hangingRows(text: string, width: number, hang: number): number {
  return hangingWrap(text, width, hang).split('\n').length;
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
