import { describe, expect, it } from 'vitest';
import { lightness, shimmerBase, shimmerRamp } from './Working.js';
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
    // The tip sits at the peak lightness, whatever channel level that takes for the hue.
    expect(lightness(ramp[2])).toBeCloseTo(77, 0);
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
      '#a2a2a2',
      '#b5b5b5',
      '#bfbfbf',
      '#b5b5b5',
      '#a2a2a2',
    ]);
    expect(shimmerBase('not-a-color')).toBe('#999999');
  });

  it('rests every accent at one lightness, a step above muted (#429)', () => {
    // Channel levels are solved per hue: at one level the default magenta sat ~9 L* under the
    // yellow spin hint and read as the dim one, its sweep the faintest.
    const mutedL = lightness(theme.muted);
    for (const accent of [theme.accent, theme.warning, theme.subagent, 'cyan']) {
      const base = shimmerBase(accent);
      expect(lightness(base)).toBeCloseTo(63, 0);
      expect(lightness(base)).toBeGreaterThan(mutedL + 8);
      // The band's rim is only a quarter step above the resting color: it feathers down to
      // the base rather than snapping.
      const rim = lightness(shimmerRamp(accent)[0]);
      expect(rim - lightness(base)).toBeCloseTo(3.5, 0);
    }
  });

  it('sweeps every accent by the same lightness', () => {
    const lift = (accent: string) =>
      lightness(shimmerRamp(accent)[2]) - lightness(shimmerBase(accent));
    const magenta = lift(theme.accent);
    expect(magenta).toBeCloseTo(14, 0);
    for (const accent of [theme.warning, theme.subagent, 'cyan']) {
      expect(Math.abs(lift(accent) - magenta)).toBeLessThan(0.5);
    }
  });
});
