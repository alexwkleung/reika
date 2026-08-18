import stripAnsi from 'strip-ansi';

// Program output is not display text. A command's stdout/stderr is a stream of terminal
// INSTRUCTIONS — move the cursor here, jump to the next tab stop, clear the screen — that a
// terminal acts on but Ink cannot see. Ink lays a frame out by measuring strings (string-width),
// and every instruction it can't measure desynchronizes the frame it thinks it drew from what the
// screen actually shows. Two of them break the bash chip in practice (issue #154):
//
//   TABS measure as width 0, so `make`/`go test`/`ls -l` output looks narrow to Ink and never
//   wraps — then the terminal expands each tab to the next 8-column stop, the line runs past the
//   viewport, and the terminal wraps it itself at a boundary Ink doesn't know about. The
//   continuation row starts at column 0 instead of under the chip's indent, and Ink's row count
//   (which the live-region budget in Scrollback depends on) is now wrong.
//
//   CARRIAGE RETURNS put the cursor back at column 0 of the PHYSICAL line — which includes the
//   chip's indent, not just the text. Any output with a progress line (`\rDownloading 42%`) paints
//   over the indent and whatever else shares that row.
//
// So flatten output to what a terminal would have SHOWN, before Ink measures it: run the cursor
// motions ourselves and emit the resulting cells. Display only — the payload the model sees keeps
// the original bytes, and the transcript keeps them too (a file is not a frame).
const TAB_STOP = 8;

export function sanitizeTerminalText(text: string, tabStop = TAB_STOP): string {
  // Escape sequences first: they can wrap or embed the control characters below (`\x1b[K`), and
  // stripping them afterwards would leave the stragglers behind. SGR colors go with them — the
  // chip renders in one muted color by design, and an unterminated color from a killed process
  // would otherwise bleed down the scrollback.
  const plain = stripAnsi(text);
  // \r\n is a line break, not a cursor motion; splitting on \n first would leave the \r to be read
  // as an overwrite and blank every line.
  return plain
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => renderLine(line, tabStop))
    .join('\n');
}

// Replay one line the way a terminal would: write each cell at the cursor, and let \r, \b and \t
// move the cursor rather than emit anything. Cells are only ever written by printable characters,
// so a tab that skips over already-written cells leaves them intact (a real tab moves the cursor,
// it does not erase), and gaps the cursor jumped past come back as spaces.
//
// Columns are counted per code point. A double-width CJK glyph therefore shifts the tab stops in
// this line by one — the same approximation Ink's own wrapping makes, and invisible unless CJK and
// tabs share a line.
function renderLine(line: string, tabStop: number): string {
  const cells: string[] = [];
  let col = 0;
  for (const ch of line) {
    if (ch === '\r') {
      col = 0;
    } else if (ch === '\b') {
      if (col > 0) col--;
    } else if (ch === '\t') {
      col = (Math.floor(col / tabStop) + 1) * tabStop;
    } else if (isControl(ch)) {
      // Bell, form feed, vertical tab, a lone ESC left by a truncated sequence: nothing a
      // scrollback row can usefully show, and each one is a width Ink would get wrong.
      continue;
    } else {
      cells[col] = ch;
      col++;
    }
  }
  let out = '';
  for (let i = 0; i < cells.length; i++) out += cells[i] ?? ' ';
  // Tab expansion and overwrites both leave trailing spaces that carry real width — enough to push
  // a line that fits into a wrap. They are invisible, so dropping them is free.
  return out.replace(/ +$/, '');
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}
