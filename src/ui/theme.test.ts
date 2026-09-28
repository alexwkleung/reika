import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { themeChalk, themeForLevel } from './theme.js';

const savedLevel = chalk.level;
afterEach(() => {
  chalk.level = savedLevel;
});

describe('themeForLevel', () => {
  it('keeps the truecolor palette above 16 colors', () => {
    expect(themeForLevel(3).accent).toBe('#d68cd6');
    expect(themeForLevel(2)).toBe(themeForLevel(3));
  });

  // Downsampled, the pastels all land on white; the 16-color palette must keep the slots that
  // share a screen apart.
  it('gives 16-color terminals distinct named colors', () => {
    const t = themeForLevel(1);
    expect(new Set([t.accent, t.warning, t.muted, t.info, t.error, t.success]).size).toBe(6);
    const modes = [
      t.modeAgent,
      t.modePlan,
      t.modeVibe,
      t.modeMinimal,
      t.modeGrind,
      t.modeChat,
      t.modeShell,
    ];
    expect(new Set(modes).size).toBe(modes.length);
    for (const c of modes) expect(c.startsWith('#')).toBe(false);
  });
});

describe('themeChalk', () => {
  it('paints both hex and named slots', () => {
    chalk.level = 1;
    expect(themeChalk('magentaBright')('x')).toBe('\x1b[95mx\x1b[39m');
    chalk.level = 3;
    expect(themeChalk('#d68cd6')('x')).toBe(chalk.hex('#d68cd6')('x'));
  });
});
