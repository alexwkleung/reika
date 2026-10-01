import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { drawnWidth, sanitizeTerminalText } from './termtext.js';

// Built from char codes so the test source itself stays free of raw control characters — an
// escape or a carriage return pasted into a file is invisible in every diff that reviews it.
const TAB = '\t';
const CR = '\r';
const BS = '\b';
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

describe('sanitizeTerminalText', () => {
  it('expands tabs to 8-column stops so Ink measures the width the terminal renders', () => {
    // The bug in issue #154: string-width scores a tab as 0, so Ink thought this line was 3
    // columns and never wrapped it, while the terminal drew it 17 wide and wrapped it itself.
    const line = `a${TAB}b${TAB}c`;
    expect(stringWidth(line)).toBe(3);
    expect(sanitizeTerminalText(line)).toBe('a       b       c');
    expect(stringWidth(sanitizeTerminalText(line))).toBe(17);
  });

  it('advances to the next stop from wherever the column already is', () => {
    expect(sanitizeTerminalText(`abcdefghi${TAB}x`)).toBe('abcdefghi       x');
  });

  it('keeps tab-aligned columns aligned across lines', () => {
    const rows = sanitizeTerminalText(`name${TAB}size\nf.txt${TAB}12`).split('\n');
    expect(rows[0].indexOf('size')).toBe(rows[1].indexOf('12'));
  });

  it('replays a carriage return as an overwrite, not a line break', () => {
    // Progress output. Left alone, the `\r` reaches the terminal, which returns the cursor to
    // column 0 of the physical row — the chip's indent included — and paints over it.
    expect(sanitizeTerminalText(`Downloading 42%${CR}Downloading 100%`)).toBe('Downloading 100%');
    expect(sanitizeTerminalText(`abcdef${CR}xy`)).toBe('xycdef');
    expect(sanitizeTerminalText(`abc${CR}x`)).not.toContain(CR);
  });

  it('treats CRLF as a line break', () => {
    expect(sanitizeTerminalText(`one${CR}\ntwo`)).toBe('one\ntwo');
  });

  it('applies backspace as a cursor move', () => {
    expect(sanitizeTerminalText(`abc${BS}${BS}xy`)).toBe('axy');
  });

  it('strips escape sequences, including ones that would clear the screen', () => {
    expect(sanitizeTerminalText(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeTerminalText(`before${ESC}[2J${ESC}[Hafter`)).toBe('beforeafter');
    expect(sanitizeTerminalText(`x${ESC}[Ky`)).toBe('xy');
  });

  it("strips the sequences node's util.stripVTControlCharacters leaks (#363)", () => {
    // Why strip-ansi stays a dependency: node's built-in carries an older regex on 18/20/22/23
    // (synced to strip-ansi's only in the 24.x and 26.x lines). Its OSC branch rejects payloads
    // with spaces and its SGR branch only knows `;`, so both fall through to the CSI branch,
    // which eats `ESC ] 0 ; m` and leaks the rest as text. Both are everyday bash-tool output:
    // a shell precmd title and `ls`/eza colors.
    expect(sanitizeTerminalText(`${ESC}]0;user@host: ~/Git/reika${BEL}$ ls`)).toBe('$ ls');
    expect(sanitizeTerminalText(`${ESC}[38:5:33msrc${ESC}[0m/`)).toBe('src/');
    expect(sanitizeTerminalText(`${ESC}[4:3m${ESC}[58:5:1mspell${ESC}[0m`)).toBe('spell');
  });

  it('drops stray control characters a row cannot show', () => {
    expect(sanitizeTerminalText(`ding${BEL} done`)).toBe('ding done');
  });

  it('leaves ordinary output — and its line structure — untouched', () => {
    const text = 'src/ui/App.tsx:101\n  const [x] = useState("");\n\nDone.';
    expect(sanitizeTerminalText(text)).toBe(text);
  });

  it('trims the trailing spaces tab expansion creates', () => {
    // Invisible, but they carry width — enough to wrap a line that would otherwise fit.
    expect(sanitizeTerminalText(`col${TAB}`)).toBe('col');
  });

  it('does not let a tab erase text it jumps over', () => {
    // A real tab moves the cursor; it does not blank the cells it passes.
    expect(sanitizeTerminalText(`abcdef${CR}x${TAB}z`)).toBe('xbcdef  z');
  });

  it('keeps multi-byte characters intact', () => {
    expect(sanitizeTerminalText('日本語 ✓ café')).toBe('日本語 ✓ café');
  });
});

describe('drawnWidth', () => {
  // The counterpart of the tab above: here string-width spends MORE columns than the terminal.
  // A bare text-presentation pictograph matches the emoji regex and is scored wide, but the
  // terminal draws the one-cell text glyph. Padding a table cell by the wider number left the
  // rows holding a `✔` a column short of their own borders.
  it('counts a bare text-presentation glyph as the one cell the terminal draws', () => {
    expect(stringWidth('✔')).toBe(2);
    expect(drawnWidth('✔')).toBe(1);
    expect(drawnWidth('done ✔')).toBe(stringWidth('done ') + 1);
    expect(drawnWidth('⚠ ♦ ❤')).toBe(5); // three glyphs and their two spaces
    expect(drawnWidth('\u23FA\uFE0E x')).toBe(3);
    expect(drawnWidth('\u23FA x')).toBe(3);
  });

  it('leaves alone everything both agree on', () => {
    expect(drawnWidth('漢')).toBe(2); // wide for both: not a pictograph, so not halved
    expect(drawnWidth('😀')).toBe(2); // emoji presentation, two cells for real
    expect(drawnWidth('✔\uFE0F')).toBe(2); // VS16 does ask for the emoji glyph
    expect(drawnWidth('✓')).toBe(1); // U+2713 is not an emoji at all
    expect(drawnWidth('plain ascii')).toBe(11);
    expect(drawnWidth('café → 5')).toBe(stringWidth('café → 5'));
  });

  it('measures through the styling a cell may carry', () => {
    expect(drawnWidth('\u001B[36m✔\u001B[39m')).toBe(1);
    expect(drawnWidth('\u001B[1m✔✔\u001B[22m')).toBe(2);
  });

  it('is zero for nothing at all', () => {
    expect(drawnWidth('')).toBe(0);
  });
});
