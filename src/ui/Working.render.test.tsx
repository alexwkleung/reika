import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import {
  Working,
  WORKING_WORDS,
  nextSweep,
  nextWordIndex,
  shimmerRamp,
  ticksPerWord,
} from './Working.js';

const plain = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

describe('nextWordIndex', () => {
  it('never repeats the current word', () => {
    for (const r of [0, 0.3, 0.5, 0.999]) {
      for (let cur = 0; cur < 5; cur++) expect(nextWordIndex(cur, 5, () => r)).not.toBe(cur);
    }
  });

  it('stays in range and handles a one-word pool', () => {
    expect(nextWordIndex(4, 5, () => 0.999)).toBeLessThan(5);
    expect(nextWordIndex(0, 1)).toBe(0);
  });
});

describe('WORKING_WORDS', () => {
  it('keeps plain Working in the rotation and has no duplicates', () => {
    expect(WORKING_WORDS).toContain('Working');
    expect(new Set(WORKING_WORDS).size).toBe(WORKING_WORDS.length);
  });

  it('holds a longer word longer, so it is swept in full', () => {
    expect(ticksPerWord('Photosynthesizing')).toBeGreaterThan(ticksPerWord('Budding'));
  });
});

describe('Working words', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rotates through the pool when no label is given', async () => {
    const words = ['Alpha', 'Beta'];
    const app = render(<Working words={words} />);
    const first = words.find(w => plain(app.lastFrame()).includes(`${w}…`));
    expect(first).toBeDefined();
    await vi.advanceTimersByTimeAsync(80 * (ticksPerWord(first!) + 1));
    const second = words.find(w => plain(app.lastFrame()).includes(`${w}…`));
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    app.unmount();
  });

  it('shows a harness label verbatim, never a rotating word', async () => {
    const app = render(<Working label="Typechecking" words={['Alpha']} />);
    await vi.advanceTimersByTimeAsync(80 * (ticksPerWord('Alpha') + 1) * 3);
    expect(plain(app.lastFrame())).toContain('Typechecking…');
    expect(plain(app.lastFrame())).not.toContain('Alpha');
    app.unmount();
  });

  it('falls back to Working without a pool', () => {
    const app = render(<Working />);
    expect(plain(app.lastFrame())).toContain('Working…');
    app.unmount();
  });
});

describe('shimmer sweep (#914)', () => {
  const level = chalk.level;
  const accent = '#6495ed';
  const other = '#7a90ee';
  beforeEach(() => {
    vi.useFakeTimers();
    chalk.level = 3;
  });
  afterEach(() => {
    vi.useRealTimers();
    chalk.level = level;
  });

  const tipColumn = (frame: string | undefined, color: string): number => {
    const tip = shimmerRamp(color)[Math.floor(shimmerRamp(color).length / 2)];
    const [r, g, b] = [1, 3, 5].map(i => parseInt(tip.slice(i, i + 2), 16));
    const before = (frame ?? '').split(`38;2;${r};${g};${b}m`)[0];
    return plain(before).replace(/\x1b\[[0-9;]*$/, '').length;
  };

  it('steps through a cycle and wraps', () => {
    expect(nextSweep(3, 10)).toBe(4);
    expect(nextSweep(9, 10)).toBe(0);
  });

  it('keeps its place when the cycle changes length', () => {
    expect(nextSweep(18, 41)).toBe(nextSweep(18, 40));
  });

  it('wraps a position a shorter label no longer reaches', () => {
    expect(nextSweep(35, 29)).toBe(0);
  });

  it('does not jump when a label changes width', async () => {
    const app = render(<Working label="Processing context 12% · ~15s left" accent={accent} />);
    // Past one full cycle, where the two lengths' modulos disagree.
    await vi.advanceTimersByTimeAsync(80 * 90);
    const before = tipColumn(app.lastFrame(), accent);
    app.rerender(<Working label="Processing context 26% · ~9s left" accent={accent} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(tipColumn(app.lastFrame(), accent)).toBe(before);
    app.unmount();
  });

  it('opens a new accent on a fresh sweep', async () => {
    const app = render(<Working label="Typechecking" accent={accent} />);
    await vi.advanceTimersByTimeAsync(80 * 12);
    expect(tipColumn(app.lastFrame(), accent)).toBeGreaterThan(5);
    app.rerender(<Working label="Processing context 0%" accent={other} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(tipColumn(app.lastFrame(), other)).toBeLessThan(4);
    app.unmount();
  });
});
