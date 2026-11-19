import { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';
import {
  nextSweep,
  nextWordIndex,
  SHIMMER_PAUSE,
  SHIMMER_RADIUS,
  SHIMMER_STEP,
  TICK_MS,
  ticksPerWord,
} from '../display/workingwords.js';
import { shimmerBase, shimmerRamp } from '../display/shimmer.js';

// Lighter braille "dots" spinner — its dot-mass sits nearer the text's x-height,
// so it reads as vertically aligned with the label (the fuller circular braille
// glyphs span the whole cell and look like they float above/below the text).
const FRAMES = glyphs.spinner;

// Shimmer band: a soft glow rides across the label, brightest at the tip and feathering to
// the dim baseline at the edges. Purely cosmetic — it just keeps the label from looking inert
// next to the moving spinner.
//
// A wider, feathered band (vs. a hard 1–2 char highlight) is what makes it read as a sliding
// glow instead of a robotic per-char step: at any instant several chars share the gradient,
// so movement looks continuous on the char grid.
//
const SHIMMER_HALF = SHIMMER_RADIUS; // band reaches this far from the tip.

type Clock = { tick: number; word: number; since: number; sweep: number };

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
    sweep: 0,
  }));
  const cycleRef = useRef(0);

  useEffect(() => {
    const id = setInterval(
      () =>
        setClock(c => {
          const tick = c.tick + 1;
          if (pool && tick - c.since >= ticksPerWord(pool[c.word % pool.length])) {
            return { tick, word: nextWordIndex(c.word, pool.length), since: tick, sweep: 0 };
          }
          const stepped = (tick - c.since) % SHIMMER_STEP === 0;
          return { ...c, tick, sweep: stepped ? nextSweep(c.sweep, cycleRef.current) : c.sweep };
        }),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [pool]);

  // A new accent is a new state on the line, so it opens on a fresh sweep rather than mid-glow.
  useEffect(() => {
    setClock(c => (c.sweep === 0 ? c : { ...c, sweep: 0 }));
  }, [accent]);

  const text = pool ? pool[clock.word % pool.length] : (label ?? 'Working');
  const chars = `${text}…`.split('');
  const frame = clock.tick % FRAMES.length;
  const ramp = shimmerRamp(accent);
  const base = shimmerBase(accent);
  // The shimmer tip sweeps across every char, then sits in a "pause" region past
  // the end of the label where no char is highlighted, before looping.
  cycleRef.current = chars.length + SHIMMER_PAUSE;
  const pos = clock.sweep;

  return (
    <Box marginTop={1}>
      <Text color={accent}>{FRAMES[frame]}</Text>
      <Text color={theme.muted}> </Text>
      {/* A ramp of tints needs more than 16 colors: downsampled, every stop lands on one. */}
      {chalk.level === 1 ? <Text color={accent}>{chars.join('')}</Text> : null}
      {chalk.level === 1
        ? null
        : chars.map((ch, i) => {
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
