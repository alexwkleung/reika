import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { contentWidth, hangingWrap } from './layout.js';

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
