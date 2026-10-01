import chalk from 'chalk';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from './DiffView.js';
import { drawnWidth } from './termtext.js';

const savedLevel = chalk.level;
afterEach(() => {
  chalk.level = savedLevel;
});

const frameFor = (diff: string) =>
  render(<DiffView diff={diff} path="a.txt" maxWidth={60} />).lastFrame() ?? '';

describe('DiffView on a 16-color terminal', () => {
  // Downsampled, both row tints land on black and the markers on cyan/white: the two sides read
  // the same. The side has to be carried by named red and green instead.
  it('tells added from removed rows by named color, without a black row tint', () => {
    chalk.level = 1;
    const frame = frameFor('- old words here\n+ new words here');
    const [removed, added] = frame.split('\n').filter(l => /^[+-] /.test(stripAnsi(l)));
    expect(removed).toContain('\x1b[31m');
    expect(added).toContain('\x1b[32m');
    expect(frame).not.toContain('\x1b[40m');
    expect(frame).toContain('\x1b[41m'); // the changed word
    expect(frame).toContain('\x1b[42m');
  });

  it('keeps the tinted rows at full color', () => {
    chalk.level = 3;
    expect(frameFor('- old\n+ new')).toContain('\x1b[48;2;');
  });
});

// A changed line holding a glyph the terminal draws in ONE cell and string-width spends TWO on
// (`✔`, `⚠`, `⏺` — `drawnWidth`, termtext.ts) used to come out of the pad a column short per
// glyph, so the block's right edge stepped in on exactly those rows. Padding by the drawn width
// makes such a row MEASURE wider than it draws, and Ink re-wraps what runs past the width it was
// given — the pad landed on a row of its own under the block (#439). The row box is handed that
// ink width as slack instead, so the full-width pad survives Ink's layout.
describe('DiffView rows carrying a pictograph the terminal draws narrow', () => {
  const drawn = (row: string): number => drawnWidth(stripAnsi(row));
  // Every glyph here is one the terminal draws in one cell: a check mark, a warning sign, and the
  // record glyph in both presentations. `✓` (U+2713) is not an emoji at all and is the control.
  const GLYPHS = ['✔', '⚠', '⏺', '\u23FA\uFE0E', '✓'];

  it('pads each one to the same width as a row of plain text', () => {
    chalk.level = 3;
    for (const glyph of GLYPHS) {
      const frame = frameFor(
        ['  before', `- done ${glyph} ok`, `+ done ${glyph} ok`, '  after'].join('\n'),
      );
      const changed = frame.split('\n').filter(l => stripAnsi(l).includes(`done ${glyph} ok`));
      expect(changed).toHaveLength(2);
      for (const row of changed) expect(drawn(row)).toBe(60);
    }
  });

  // The row is allowed to MEASURE a column wider than it draws — that is what lets the pad reach
  // the full width — so what this pins is that contract, not the tear: Ink's re-wrap of an
  // over-wide row only bites where the diff sits inside a width-bounded block, which the Scrollback
  // test ('keeps a row holding a one-cell pictograph padded and untorn') reproduces.
  it('measures one column wider than it draws, so the pad can fill', () => {
    chalk.level = 3;
    const changed = frameFor(['  before', '+ done ✔ ok', '  after'].join('\n'))
      .split('\n')
      .find(l => stripAnsi(l).includes('done ✔ ok'))!;
    expect(stringWidth(stripAnsi(changed))).toBe(61); // ink
    expect(drawn(changed)).toBe(60); // and what the screen spends
  });
});
