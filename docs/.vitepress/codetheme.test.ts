import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { palette } from '../../src/display/palette';
import { reikaCodeTheme, syntaxTones } from './codetheme';

const appCss = readFileSync(new URL('../../src/web/client/app.css', import.meta.url), 'utf8');
const cssVar = (name: string) => appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];

describe('the site code theme', () => {
  it('takes rose and gray from the web UI, so the two pages draw code alike', () => {
    expect(syntaxTones.rose).toBe(cssVar('reika-syntax-rose'));
    expect(syntaxTones.gray).toBe(cssVar('reika-syntax-gray'));
  });

  it('colors with nothing but the syntax tones and the text color', () => {
    const allowed = new Set<string>([
      ...Object.values(syntaxTones),
      reikaCodeTheme.colors['editor.foreground'],
    ]);
    for (const rule of reikaCodeTheme.tokenColors) {
      if (rule.settings.foreground) expect(allowed).toContain(rule.settings.foreground);
    }
  });

  it('reads its other six tones from the palette', () => {
    const { rose: _rose, gray: _gray, ...fromPalette } = syntaxTones;
    for (const hex of Object.values(fromPalette)) expect(Object.values(palette)).toContain(hex);
  });
});
