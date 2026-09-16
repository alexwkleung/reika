import { describe, expect, it } from 'vitest';
import { shimmerBase, shimmerRamp } from './Working.js';
import { theme } from './theme.js';

// The label carries the spinner's hue (#349): a hex accent keeps its channel ratios across the
// ramp, a chalk-named accent maps to the same shape, and anything else falls back to the old
// neutral grey rather than to black.

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe('shimmerRamp', () => {
  it('is symmetric around the tip and brightest there', () => {
    const ramp = shimmerRamp(theme.accent);
    expect(ramp).toHaveLength(5);
    expect(ramp[0]).toBe(ramp[4]);
    expect(ramp[1]).toBe(ramp[3]);
    const lum = ramp.map(c => Math.max(...rgb(c)));
    expect(lum[2]).toBeGreaterThan(lum[1]);
    expect(lum[1]).toBeGreaterThan(lum[0]);
    // The tip lands near the accent's own brightness, not the flat grey peak.
    expect(lum[2]).toBe(0xd2);
  });

  it('keeps the accent hue: the dominant channel stays dominant', () => {
    // Orchid magenta: red and blue lead, green trails.
    for (const c of shimmerRamp(theme.accent)) {
      const [r, g, b] = rgb(c);
      expect(r).toBe(b);
      expect(g).toBeLessThan(r);
    }
    // Apricot subagent: red > green > blue throughout.
    for (const c of shimmerRamp(theme.subagent)) {
      const [r, g, b] = rgb(c);
      expect(r).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(b);
    }
  });

  it('maps chalk-named accents (theme.info = cyan) to a tinted ramp', () => {
    for (const c of shimmerRamp('cyan')) {
      const [r, g, b] = rgb(c);
      expect(g).toBe(b);
      expect(r).toBeLessThan(g);
    }
  });

  it('falls back to neutral grey for an unrecognised accent', () => {
    expect(shimmerRamp('not-a-color')).toEqual([
      '#959595',
      '#bebebe',
      '#d2d2d2',
      '#bebebe',
      '#959595',
    ]);
    expect(shimmerBase('not-a-color')).toBe(theme.muted);
  });

  it('rests at the muted brightness so the label sits back like the old grey did', () => {
    for (const accent of [theme.accent, theme.warning, theme.subagent, 'cyan']) {
      const base = shimmerBase(accent);
      expect(Math.max(...rgb(base))).toBe(0x80);
      // The band's rim is only a quarter step above the resting color: it feathers down to
      // the base rather than snapping.
      const rim = Math.max(...rgb(shimmerRamp(accent)[0]));
      expect(rim - 0x80).toBe(0x15);
    }
  });
});
