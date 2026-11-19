// The TUI's palette: display/palette.ts, less three slots a terminal names instead (below).

import chalk, { type ForegroundColorName } from 'chalk';
import { palette } from '../display/palette.js';

// Named colours here, so the user's terminal theme decides how info, error and success look.
const truecolor: Theme = { ...palette, info: 'cyan', error: 'red', success: 'green' };

export type Theme = Record<keyof typeof palette, string>;

// A 16-color terminal (the Linux console, TERM=vt100/ansi, an old ssh client) gets named colors in
// place of the pastels. Chalk downsamples a hex to the nearest of 16, and nearly every pastel in display/palette.ts
// is nearest to white — accent, warning and every mode tag collapsed into one, so the colors meant
// nothing. The hues are chosen per slot; 16 colors cannot keep every distinction, so the ones that
// share a color (queued/subagent, link/reasoning/prefill) never meet on screen. `userBg` and the named
// slots already downsample fine and are left alone.
const ansi16: Partial<Theme> = {
  accent: 'magentaBright',
  inlineCode: 'magenta',
  tool: 'white',
  secondary: 'gray',
  muted: 'gray',
  reasoning: 'blueBright',
  prefill: 'blueBright',
  warning: 'yellowBright',
  queued: 'yellow',
  subagent: 'yellow',
  autoApprove: 'redBright',
  modeAgent: 'magentaBright',
  modePlan: 'cyanBright',
  modeVibe: 'blue',
  modeMinimal: 'white',
  modeGrind: 'magenta',
  modeChat: 'cyan',
  modeShell: 'greenBright',
  prMerged: 'magenta',
  link: 'blueBright',
};

export function themeForLevel(level: number): Theme {
  return level === 1 ? { ...truecolor, ...ansi16 } : truecolor;
}

export const theme: Theme = themeForLevel(chalk.level);

// chalk.hex for a theme slot, which may hold a named color on a 16-color terminal.
export function themeChalk(color: string) {
  return color.startsWith('#') ? chalk.hex(color) : chalk[color as ForegroundColorName];
}
