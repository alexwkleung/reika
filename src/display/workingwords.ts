// The working line's words and timing, shared by the TUI's Working (Ink) and the web page's busy
// line, so the two rotate the same verbs at the same pace. Nothing here may load Ink or Node.

// The full-glyph spinner; glyphs.ts falls back to ASCII on a console that cannot draw braille.
export const BRAILLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const SHIMMER_RADIUS = 2; // band reaches this many chars either side of the tip.

// One 80ms timer drives both effects (a single re-render per tick). The spinner
// advances every tick; the shimmer tip advances every SHIMMER_STEP ticks so it
// sweeps more slowly and calmly than the spinner spins.
export const TICK_MS = 80;
export const SHIMMER_STEP = 2; // ticks per shimmer step (~160ms) — gentle, not strobey.
export const SHIMMER_PAUSE = 6; // dark frames after each sweep so it breathes.

// Rotating words for the default label (#500, `REIKA_WORKING_WORDS`). Garden and perfumery
// verbs, after the orchid the brand is drawn from. Other verbs may be included for completeness.
// Only the idle-turn "Working" rotates: a harness state
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
  'Fragrancing',
  'Reminiscenting',
  'Perfuminating',
  'Majesticating',
  'Beautifying',
  'Lovelifying',
  'Cherrying',
  'Cherryifying',
  'Eleganting',
  'Summering',
  'Flowering',
  'Exploring',
  'Reikaing',
  'Reikaifying',
  'Reikaizing',
  'Naturing',
  'Leafing',
  'Candying',
  'Wising',
  'Refining',
  'Floraling',
  'Adoring',
  'Gracing',
  'Floralizing',
  'Cherryizing',
  'Majesticizing',
  'Perfumizing',
  'Bouqueting',
  'Flourishing',
  'Posying',
] as const;
// A word holds for this many full shimmer sweeps, so it swaps in the pause after a sweep
// rather than mid-glow, and a longer word stays up as long as it takes to sweep it.
const SWEEPS_PER_WORD = 4;

export function ticksPerWord(word: string): number {
  return SWEEPS_PER_WORD * (word.length + 1 + SHIMMER_PAUSE) * SHIMMER_STEP;
}

// A random index other than `current`, so a swap is always visibly a swap.
export function nextWordIndex(current: number, count: number, rand = Math.random): number {
  if (count < 2) return 0;
  const step = 1 + Math.floor(rand() * (count - 1));
  return (current + step) % count;
}

// Stepped rather than derived from the tick: `cycle` follows the label's length, so a modulo moved
// the tip whenever a prefill label changed width (#914). A shorter label past its end wraps here.
export function nextSweep(sweep: number, cycle: number): number {
  return sweep + 1 >= cycle ? 0 : sweep + 1;
}
