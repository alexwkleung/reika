import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

// Lighter braille "dots" spinner — its dot-mass sits nearer the text's x-height,
// so it reads as vertically aligned with the label (the fuller circular braille
// glyphs span the whole cell and look like they float above/below the text).
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Shimmer band: a soft glow rides across the label, brightest at the tip and feathering to
// the dim baseline at the edges. Purely cosmetic — it just keeps the label from looking inert
// next to the moving spinner.
//
// A wider, feathered band (vs. a hard 1–2 char highlight) is what makes it read as a sliding
// glow instead of a robotic per-char step: at any instant several chars share the gradient,
// so movement looks continuous on the char grid.
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
const SHIMMER_RADIUS = 2; // band reaches this many chars either side of the tip.
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
const SHIMMER_HALF = SHIMMER_RADIUS; // band reaches this far from the tip.

// One 80ms timer drives both effects (a single re-render per tick). The spinner
// advances every tick; the shimmer tip advances every SHIMMER_STEP ticks so it
// sweeps more slowly and calmly than the spinner spins.
const TICK_MS = 80;
const SHIMMER_STEP = 2; // ticks per shimmer step (~160ms) — gentle, not strobey.
const SHIMMER_PAUSE = 6; // dark frames after each sweep so it breathes.

// Rotating words for the default label (#500, `REIKA_WORKING_WORDS`). Garden and perfumery
// verbs, after the orchid the brand is drawn from. Only the idle-turn "Working" rotates: a harness state
// (typechecking, loop recovery, the spin hint) is information and keeps its fixed wording.
export const WORKING_WORDS = [
  'Working',
  'Blooming',
  'Budding',
  'Unfurling',
  'Sprouting',
  'Tending',
  'Pruning',
  'Grafting',
  'Rooting',
  'Germinating',
  'Cultivating',
  'Pollinating',
  'Arranging',
  'Blossoming',
  'Photosynthesizing',
  'Perfuming',
  'Scenting',
  'Wafting',
  'Diffusing',
  'Distilling',
  'Infusing',
  'Steeping',
  'Macerating',
  'Blending',
  'Enfleuraging',
] as const;
// A word holds for this many full shimmer sweeps, so it swaps in the pause after a sweep
// rather than mid-glow, and a longer word stays up as long as it takes to sweep it.
const SWEEPS_PER_WORD = 3;

export function ticksPerWord(word: string): number {
  return SWEEPS_PER_WORD * (word.length + 1 + SHIMMER_PAUSE) * SHIMMER_STEP;
}

// A random index other than `current`, so a swap is always visibly a swap.
export function nextWordIndex(current: number, count: number, rand = Math.random): number {
  if (count < 2) return 0;
  const step = 1 + Math.floor(rand() * (count - 1));
  return (current + step) % count;
}

type Clock = { tick: number; word: number; since: number };

// `accent` colors the spinner glyph (default = brand magenta). A distinct accent — e.g. cyan while
// the harness is typechecking — makes a transient state read at a glance rather than as a mere
// word-swap on an already-spinning indicator. `words` rotates the default label when no `label`
// is given.
export function Working({
  label,
  accent = theme.accent,
  words,
}: {
  label?: string;
  accent?: string;
  words?: readonly string[];
}) {
  const pool = label === undefined && words && words.length > 0 ? words : null;
  const [clock, setClock] = useState<Clock>(() => ({
    tick: 0,
    word: words && words.length > 0 ? Math.floor(Math.random() * words.length) : 0,
    since: 0,
  }));

  useEffect(() => {
    const id = setInterval(
      () =>
        setClock(c => {
          const tick = c.tick + 1;
          if (pool && tick - c.since >= ticksPerWord(pool[c.word % pool.length])) {
            return { tick, word: nextWordIndex(c.word, pool.length), since: tick };
          }
          return { ...c, tick };
        }),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [pool]);

  const text = pool ? pool[clock.word % pool.length] : (label ?? 'Working');
  const chars = `${text}…`.split('');
  const frame = clock.tick % FRAMES.length;
  const ramp = shimmerRamp(accent);
  const base = shimmerBase(accent);
  // The shimmer tip sweeps across every char, then sits in a "pause" region past
  // the end of the label where no char is highlighted, before looping. Measured from the
  // word's first tick so a new word starts on a fresh sweep.
  const cycle = chars.length + SHIMMER_PAUSE;
  const pos = Math.floor((clock.tick - clock.since) / SHIMMER_STEP) % cycle;

  return (
    <Box marginTop={1}>
      <Text color={accent}>{FRAMES[frame]}</Text>
      <Text color={theme.muted}> </Text>
      {chars.map((ch, i) => {
        const d = i - pos; // signed distance from the shimmer tip.
        const within = Math.abs(d) <= SHIMMER_HALF;
        const color = within ? ramp[d + SHIMMER_HALF] : base;
        return (
          <Text key={i} color={color}>
            {ch}
          </Text>
        );
      })}
    </Box>
  );
}
