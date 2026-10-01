import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { Input, wrapBuffer } from './Input.js';

const COLS = 100;
// The columns the buffer's <Text> is laid out in: the box spans the frame — it pulls out over App's
// paddingX={1} with marginX={-1} — so its border (2), padding (1 + 2) and the prompt come off the
// width Ink lays the frame out in (ink-testing-library's Stdout.columns, asserted in `frame`).
const TEXT_WIDTH = COLS - 7;

// Rendered the way App does it. The box is only terminal-wide under that padding, so the frame is
// what tells us the wrap the component computes.
function frame(value: string): { rows: string[]; raw: string[] } {
  const app = render(
    <Box flexDirection="column" paddingX={1}>
      <Input
        value={value}
        onChange={() => {}}
        onSubmit={() => {}}
        disabled={false}
        mode="agent"
        suggesting={false}
        history={[]}
      />
    </Box>,
  );
  expect(app.stdout.columns).toBe(COLS);
  const raw = (app.lastFrame() ?? '').split('\n').filter(l => l.startsWith('│'));
  return { rows: raw.map(stripAnsi), raw };
}

// The column the cursor block is drawn in, measured on the frame as the terminal receives it.
function cursorColumn(row: string): number {
  return stringWidth(stripAnsi(row.slice(0, row.indexOf('\x1b[7m'))));
}

describe('wrapBuffer', () => {
  it('leaves a buffer that fits the box alone', () => {
    const value = 'a short line';
    expect(wrapBuffer(value, 7, 33)).toEqual({ text: value, cursor: 7 });
  });

  it('drops the whitespace a break landed on, instead of starting the row with it', () => {
    // 33 columns of text, then the space that cannot fit: Yoga puts it at the head of the next row.
    const value = `${'w'.repeat(33)} abc`;
    expect(wrapBuffer(value, value.length, 33)).toEqual({
      text: `${'w'.repeat(33)}\nabc`,
      cursor: 37,
    });
  });

  it('keeps whitespace that starts a line the user typed, not a wrap', () => {
    const value = `${'w'.repeat(33)}\n  indented`;
    expect(wrapBuffer(value, value.length, 33).text).toBe(`${'w'.repeat(33)}\n  indented`);
  });

  it('breaks an over-long token without inventing whitespace to drop', () => {
    expect(wrapBuffer('abcdefghij', 10, 4).text).toBe('abcd\nefgh\nij');
    expect(wrapBuffer('abcdefghij', 4, 4).cursor).toBe(4);
  });

  it('puts a cursor resting on the break character at the head of the row it lands in', () => {
    // Cursor just after the space: the row it belongs to is the one the space was dropped from.
    const value = `${'w'.repeat(33)} abc`;
    expect(wrapBuffer(value, 34, 33).cursor).toBe(34);
    // Cursor on the space itself.
    expect(wrapBuffer(value, 33, 33).cursor).toBe(33);
  });
});

describe('the input box at the wrap edge', () => {
  it('starts the wrapped row at the text column, not one column right of it', () => {
    const { rows } = frame(`${'w'.repeat(TEXT_WIDTH)} abc`);
    // rows[0] is the prompt row, rows[1] the row the buffer wrapped into.
    expect(rows[1]).toContain('abc');
    // The bug: the space the break happened on was rendered at the head of the second row, so the
    // text (and everything typed after it) sat a column right of the row above.
    expect(rows[1]!.indexOf('abc')).toBe(rows[0]!.indexOf('w'));
  });

  it('draws the cursor block on that column too when a space lands on the edge', () => {
    const { rows, raw } = frame(`${'w'.repeat(TEXT_WIDTH)} `);
    // Row 1 holds the fill; the cursor cell is the whole of row 2, at the text's own column. The
    // cell is drawn as a no-break space (renderWithCursor), which is the row's only non-blank.
    expect(cursorColumn(raw[1]!)).toBe(rows[0]!.indexOf('w'));
    expect(rows[1]!.replaceAll('\u00a0', ' ')).toBe(`│${' '.repeat(COLS - 2)}│`);
    expect(rows[1]!.indexOf('\u00a0')).toBe(rows[0]!.indexOf('w'));
  });
});
