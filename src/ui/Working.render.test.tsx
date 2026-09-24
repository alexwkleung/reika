import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Working, WORKING_WORDS, nextWordIndex, ticksPerWord } from './Working.js';

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
