import { describe, expect, it } from 'vitest';
import { frameRise } from './framedrops.js';

// Ink's two frame shapes (build/log-update.js, build/ink.js): `eraseLines(prev) + output`, and on a
// commit `eraseLines(prev) + static + output`, where log-update counts `output + '\n'` as its lines.
// ansi-escapes' eraseLines, spelled out: it is Ink's dependency, not ours.
const eraseLines = (n: number): string =>
  Array.from({ length: n }, (_, i) => '\x1b[2K' + (i < n - 1 ? '\x1b[1A' : '')).join('') +
  (n ? '\x1b[G' : '');
const frame = (prevLines: number, ...rows: string[][]): string =>
  eraseLines(prevLines) + rows.map(r => r.join('\n') + '\n').join('');

describe('frameRise', () => {
  it('is zero for a redraw of the same height', () => {
    expect(frameRise(frame(4, ['a', 'b', 'c']))).toBe(0);
  });

  it('is zero when the frame grows', () => {
    expect(frameRise(frame(4, ['a', 'b', 'c', 'd', 'e']))).toBe(0);
  });

  it('counts the rows a shrinking frame leaves the input above where it was', () => {
    expect(frameRise(frame(13, ['a', 'b']))).toBe(10);
  });

  it('counts a commit’s static rows against the erased frame', () => {
    expect(frameRise(frame(13, ['s1', 's2', 's3', 's4'], ['a', 'b']))).toBe(6);
    expect(
      frameRise(
        frame(
          13,
          Array.from({ length: 20 }, (_, i) => `s${i}`),
          ['a'],
        ),
      ),
    ).toBe(0);
  });

  it('says nothing about a full-screen repaint', () => {
    expect(frameRise('\x1b[2J\x1b[3J\x1b[H' + 'a\nb\n')).toBeNull();
  });
});
