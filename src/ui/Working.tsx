import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

// Lighter braille "dots" spinner — its dot-mass sits nearer the text's x-height,
// so it reads as vertically aligned with the label (the fuller circular braille
// glyphs span the whole cell and look like they float above/below the text).
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Shimmer band: a soft glow rides across the muted label, brightest at the tip
// and feathering to the muted baseline at the edges. Purely cosmetic — it just
// keeps the label from looking inert next to the moving spinner.
//
// A wider, feathered band (vs. a hard 1–2 char highlight) is what makes it read
// as a sliding glow instead of a robotic per-char step: at any instant several
// chars share the gradient, so movement looks continuous on the char grid.
const MUTED = 0x80; // grey baseline, matches theme.muted (#808080).
const PEAK = 0xd2; // brightest grey at the tip.
const SHIMMER_RADIUS = 2; // band reaches this many chars either side of the tip.

function greyHex(v: number): string {
  const h = Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, '0');
  return `#${h}${h}${h}`;
}

// Precompute the brightness ramp with a cosine falloff so the edges feather
// (~25% bright at the band's rim) rather than stepping hard to muted.
const SHIMMER = Array.from({ length: SHIMMER_RADIUS * 2 + 1 }, (_, i) => {
  const d = i - SHIMMER_RADIUS;
  const w = (1 + Math.cos((Math.PI * d) / (SHIMMER_RADIUS + 1))) / 2; // 1 at tip → ~0 at rim.
  return greyHex(MUTED + (PEAK - MUTED) * w);
});
const SHIMMER_HALF = SHIMMER_RADIUS; // band reaches this far from the tip.

// One 80ms timer drives both effects (a single re-render per tick). The spinner
// advances every tick; the shimmer tip advances every SHIMMER_STEP ticks so it
// sweeps more slowly and calmly than the spinner spins.
const TICK_MS = 80;
const SHIMMER_STEP = 2; // ticks per shimmer step (~160ms) — gentle, not strobey.
const SHIMMER_PAUSE = 6; // dark frames after each sweep so it breathes.

// `accent` colors the spinner glyph (default = brand magenta). A distinct accent — e.g. cyan while
// the harness is typechecking — makes a transient state read at a glance rather than as a mere
// word-swap on an already-spinning indicator.
export function Working({
  label = 'Working',
  accent = theme.accent,
}: {
  label?: string;
  accent?: string;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const chars = `${label}…`.split('');
  const frame = tick % FRAMES.length;
  // The shimmer tip sweeps across every char, then sits in a "pause" region past
  // the end of the label where no char is highlighted, before looping.
  const cycle = chars.length + SHIMMER_PAUSE;
  const pos = Math.floor(tick / SHIMMER_STEP) % cycle;

  return (
    <Box marginTop={1}>
      <Text color={accent}>{FRAMES[frame]}</Text>
      <Text color={theme.muted}> </Text>
      {chars.map((ch, i) => {
        const d = i - pos; // signed distance from the shimmer tip.
        const within = Math.abs(d) <= SHIMMER_HALF;
        const color = within ? SHIMMER[d + SHIMMER_HALF] : theme.muted;
        return (
          <Text key={i} color={color}>
            {ch}
          </Text>
        );
      })}
    </Box>
  );
}
