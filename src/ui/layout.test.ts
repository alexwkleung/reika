import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import { contentWidth, hangingWrap, wrapStyledRows } from './layout.js';

describe('contentWidth', () => {
  it('pays for the App’s paddingX and any block indent', () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    try {
      expect(contentWidth()).toBe(98);
      expect(contentWidth(4)).toBe(94);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  });

  it('floors at 20 columns so a narrow terminal can’t produce a zero-width layout', () => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
    try {
      expect(contentWidth()).toBe(20);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  });
});

// Issue #167: a marker and its text share one <Text>, so Ink wrapped the pair at the block's left
// edge and every continuation row landed back at column 0, detached from the line it belonged to.
describe('hangingWrap', () => {
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima';

  it('indents every row after the first by the marker width', () => {
    const rows = hangingWrap(words, 30, 4).split('\n');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.startsWith(' ')).toBe(false);
    for (const row of rows.slice(1)) expect(row).toMatch(/^ {4}\S/);
  });

  it('keeps every row inside the width once the marker is added back', () => {
    const marker = '  ↳ ';
    const rows = hangingWrap(words, 30, marker.length).split('\n');
    expect(stringWidth(marker + rows[0]!)).toBeLessThanOrEqual(30);
    for (const row of rows.slice(1)) expect(stringWidth(row)).toBeLessThanOrEqual(30);
  });

  it('gives the first row less room when the prefix is wider than the indent', () => {
    // `⏺︎ Bash` sits between the marker and the args: the first row is short by the name, but the
    // indent the rest hangs from is still the marker's two columns.
    const wide = hangingWrap(words, 30, 2, 8);
    const narrow = hangingWrap(words, 30, 2, 2);
    expect(stringWidth(wide.split('\n')[0]!)).toBe(stringWidth(narrow.split('\n')[0]!) - 6);
    for (const row of wide.split('\n').slice(1)) expect(row).toMatch(/^ {2}\S/);
  });

  it('drops the whole run of whitespace a wrap broke on, not just one space', () => {
    // Tab-expanded output breaks inside an 8-column gap; keeping that gap would stagger each row
    // further right than the last.
    const rows = hangingWrap('x'.padEnd(20) + 'y'.padEnd(20) + 'z', 12, 2).split('\n');
    // A row the wrap left with nothing but that whitespace comes back empty, not as bare padding.
    for (const row of rows.slice(1)) expect(row).toMatch(/^(?: {2}\S.*)?$/);
  });

  it('keeps leading whitespace that follows a real newline — that is content, not a wrap', () => {
    const rows = hangingWrap('first\n    indented second', 40, 2).split('\n');
    expect(rows).toEqual(['first', '      indented second']);
  });

  it('hard-splits a token longer than the width instead of overflowing', () => {
    const rows = hangingWrap('a'.repeat(50), 20, 2).split('\n');
    expect(rows.length).toBeGreaterThan(1);
    // First row: 18 columns plus the 2 the marker will occupy. Later rows: the indent plus 18.
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(20);
    expect(rows.join('').replace(/ /g, '')).toBe('a'.repeat(50));
  });

  it('is a no-op on text that already fits', () => {
    expect(hangingWrap('short', 40, 4)).toBe('short');
  });
});

// wrap-ansi re-opens only the innermost code at a break, so a comment (gray, then italic) came back
// italic in the default foreground on its continuation rows (#852).
describe('wrapStyledRows', () => {
  const GRAY = '\x1b[38;2;127;132;142m';
  const comment = `x = 1; ${GRAY}\x1b[3m// a long comment that wraps across rows\x1b[23m\x1b[39m`;

  it('re-opens every stacked style on each continuation row', () => {
    const rows = wrapStyledRows(comment, 16);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows.slice(1)) {
      expect(row.startsWith(GRAY)).toBe(true);
      expect(row).toContain('\x1b[3m');
    }
  });

  it('closes what it opened, so a row leaks no style', () => {
    for (const row of wrapStyledRows(comment, 16)) {
      expect(row.lastIndexOf('\x1b[39m')).toBeGreaterThan(row.lastIndexOf(GRAY));
    }
  });

  it('breaks where wrap-ansi breaks, so the row count is unchanged', () => {
    const plain = wrapAnsi(comment, 16, { trim: false, hard: true })
      .split('\n')
      .map(r => stripAnsi(r));
    expect(wrapStyledRows(comment, 16).map(r => stripAnsi(r))).toEqual(plain);
  });

  it('carries a background and a 256-color foreground, and drops a style once reset', () => {
    const text = '\x1b[48;2;1;2;3m\x1b[38;5;109maaaa bbbb\x1b[0m cccc dddd';
    const rows = wrapStyledRows(text, 5);
    expect(rows[1].startsWith('\x1b[48;2;1;2;3m\x1b[38;5;109m')).toBe(true);
    expect(rows.at(-1)).not.toContain('\x1b[48;2;');
  });

  it('leaves unstyled text as wrap-ansi wraps it', () => {
    expect(wrapStyledRows('aaaa bbbb cccc', 5)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
  });
});
