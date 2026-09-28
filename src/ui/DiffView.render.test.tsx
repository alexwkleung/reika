import chalk from 'chalk';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from './DiffView.js';

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
