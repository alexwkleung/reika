import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

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

// The other direction from the tab above: a glyph the terminal draws in ONE column that Ink's
// measurement spends TWO on. string-width asks the emoji regex, which holds the pictographs that
// default to TEXT presentation too — `✔`, `⚠`, `♦`, `❤`, the record glyph `⏺` (syncframe.ts) —
// and scores them wide, because the emoji font can draw them at double width. A terminal only does
// that for a glyph that actually presents as an emoji: `✔` bare is East Asian Ambiguous, the
// default is narrow, and CP437/WGL4 fonts carry it as a one-cell text glyph. So `✔️` (U+2714 +
// VS16) really is two cells and `✔` is one; a CJK glyph or an emoji-presentation pictograph is two
// for both, and `✓` (U+2713) is not an emoji at all.
//
// Callers that PAD to a column want this. Callers that BUDGET want string-width, since that is
// what Ink re-wraps by: a table pads cells by `drawnWidth` and pays the difference out of its fit
// budget (markdown.ts, `renderTable`).
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// VS16 asks the terminal for the emoji glyph, VS15 for the text one; with neither, the code
// point's own default presentation decides. string-width ignores both selectors and keeps the
// emoji regex's verdict, so the pair has to be read here.
const ASKS_FOR_EMOJI = /\uFE0F/;
const ASKS_FOR_TEXT = /\uFE0E/;
const segmenter = new Intl.Segmenter();

export function drawnWidth(text: string): number {
  let width = 0;
  // Grapheme by grapheme, the way string-width counts: a ZWJ sequence is one glyph on screen and
  // a combining mark spends no cell of its own.
  for (const { segment } of segmenter.segment(stripAnsi(text))) {
    const measured = stringWidth(segment);
    const textPresentation =
      measured === 2 &&
      PICTOGRAPHIC.test(segment) &&
      !ASKS_FOR_EMOJI.test(segment) &&
      (ASKS_FOR_TEXT.test(segment) || !EMOJI_PRESENTATION.test(segment));
    width += textPresentation ? 1 : measured;
  }
  return width;
}
