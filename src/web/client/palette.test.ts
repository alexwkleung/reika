import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { palette } from '../../display/palette.js';
import { WIRE_MODES } from '../protocol.js';
import { applyPalette, paletteVars } from './palettevars.js';

const here = import.meta.dirname;
const source = (file: string) => readFileSync(join(here, file), 'utf8');
const cssFiles = readdirSync(here).filter(f => f.endsWith('.css'));

describe('palette variables', () => {
  it('gives every palette slot a hex variable', () => {
    const vars = paletteVars();
    expect(vars).toHaveLength(Object.keys(palette).length);
    expect(vars.filter(([, v]) => !/^#[0-9a-f]{6}$/.test(v))).toEqual([]);
    expect(Object.fromEntries(vars)['--reika-mode-plan']).toBe(palette.modePlan);
  });

  it('sets them on the style it is handed', () => {
    const set: Record<string, string> = {};
    applyPalette({ setProperty: (name: string, value: string | null) => (set[name] = value!) });
    expect(set['--reika-accent']).toBe(palette.accent);
  });

  // One source: a copy on :root would lose to the inline value and drift unseen, and a scoped
  // override of a shared slot would make the page disagree with the TUI.
  it('leaves no palette slot declared in the stylesheets', () => {
    const names = paletteVars().map(([name]) => name);
    const copied = cssFiles.flatMap(f =>
      names.filter(n => new RegExp(`${n}\\s*:`).test(source(f))).map(n => `${f}: ${n}`),
    );
    expect(copied).toEqual([]);
  });

  it('defines every --reika-* variable the stylesheets use', () => {
    const defined = new Set([
      ...paletteVars().map(([name]) => name),
      ...cssFiles.flatMap(f => [...source(f).matchAll(/(--reika-[\w-]+)\s*:/g)].map(m => m[1]!)),
    ]);
    const used = cssFiles.flatMap(f =>
      [...source(f).matchAll(/var\((--reika-[\w-]+)/g)].map(m => `${f}: ${m[1]}`),
    );
    expect(used.filter(u => !defined.has(u.split(': ')[1]!))).toEqual([]);
  });

  // Composer and LiveTurn build these names in code, where the stylesheet scan above cannot see them.
  it('has a mode colour for every mode the page can show', () => {
    const names = new Set(paletteVars().map(([name]) => name));
    expect(WIRE_MODES.filter(m => !names.has(`--reika-mode-${m}`))).toEqual([]);
  });

  // The stylesheets no longer carry the shared colours, so the page has them only if this runs.
  it('is applied by the entry before the first render', () => {
    const main = source('main.tsx');
    const applied = main.indexOf('applyPalette(document.documentElement.style)');
    expect(applied).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(main.indexOf('createRoot('));
  });
});
