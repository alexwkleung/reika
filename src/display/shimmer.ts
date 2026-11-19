import { SHIMMER_RADIUS } from './workingwords.js';

// The working line's colours, shared by the TUI's Working and the web page's busy line so both
// glow the same: pure, so the browser bundle can import it.
//
// The label takes the spinner's hue (#349): the ramp runs from a dim tint of `accent` up to
// (nearly) the accent itself, so a typecheck reads cyan, a subagent apricot, a suspected loop
// yellow — the whole line, not just one glyph. The closing "Worked for …" line stays muted
// grey (Scrollback), which is what keeps a live indicator distinct from a finished one.
// Resting and peak lightness as CIE L* (0–100), not channel levels (#429): at one channel
// level a magenta label sits ~9 L* under a yellow one (its channels carry far less of the
// luminance weight), so the default turn read dimmer than every harness state and its sweep
// was the faintest. Solving the channel level per hue makes every accent rest at the same
// lightness and sweep by the same amount. Base lands a step above theme.muted's L* 54, the
// live/finished distinction.
const BASE_L = 63;
const PEAK_L = 77; // brightest level at the tip.
// How much of the accent's chroma the label keeps. 1 would be the pure hue (a cyan label's red
// channel pinned to 0, which goes murky at the dim end); a little white mixed in keeps the
// baseline legible while the tint still reads.
const CHROMA = 0.85;

// Ink accepts chalk's named colors as well as hex; the theme uses `cyan` for `info`. Only the
// channel ratios matter here, so the names map to unit vectors.
const NAMED: Record<string, [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  yellow: [1, 1, 0],
  blue: [0, 0, 1],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
  white: [1, 1, 1],
  gray: [1, 1, 1],
  grey: [1, 1, 1],
};

// Unit hue vector (max channel = 1) for a color, or grey for anything unrecognised so an
// unexpected accent degrades to the old neutral shimmer rather than to black.
function hue(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    const rgb: [number, number, number] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    const max = Math.max(...rgb);
    if (max === 0) return [1, 1, 1];
    return [rgb[0] / max, rgb[1] / max, rgb[2] / max];
  }
  return NAMED[color.toLowerCase()] ?? [1, 1, 1];
}

// `hue` at brightness `v` (0–255 on its max channel), with the chroma softened.
function tinted(h: [number, number, number], v: number): string {
  return `#${h
    .map(c => (CHROMA * c + (1 - CHROMA)) * v)
    .map(x =>
      Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

// CIE L* of an sRGB hex: the lightness the eye actually reads.
export function lightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff);
  return 116 * (y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116) - 16;
}

// The tint of `h` that lands nearest lightness `L`. Lightness is monotone in `v`, so a bisection
// over the 256 levels finds it; a target brighter than the hue can reach clamps to full.
function tintAtLightness(h: [number, number, number], L: number): string {
  let lo = 0;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lightness(tinted(h, mid)) < L) lo = mid + 1;
    else hi = mid;
  }
  return tinted(h, lo);
}

// The brightness ramp for one accent, tip in the middle, with a cosine falloff so the edges
// feather (~25% bright at the band's rim) rather than stepping hard to the baseline. Exported
// for tests; cached because the accent set is tiny and the component re-renders every tick.
const ramps = new Map<string, string[]>();
export function shimmerRamp(accent: string): string[] {
  const cached = ramps.get(accent);
  if (cached) return cached;
  const h = hue(accent);
  const ramp = Array.from({ length: SHIMMER_RADIUS * 2 + 1 }, (_, i) => {
    const d = i - SHIMMER_RADIUS;
    const w = (1 + Math.cos((Math.PI * d) / (SHIMMER_RADIUS + 1))) / 2; // 1 at tip → ~0 at rim.
    return tintAtLightness(h, BASE_L + (PEAK_L - BASE_L) * w);
  });
  ramps.set(accent, ramp);
  return ramp;
}

// The label's resting color: the accent at the baseline lightness. Cached like the ramp.
const bases = new Map<string, string>();
export function shimmerBase(accent: string): string {
  let base = bases.get(accent);
  if (!base) {
    base = tintAtLightness(hue(accent), BASE_L);
    bases.set(accent, base);
  }
  return base;
}
