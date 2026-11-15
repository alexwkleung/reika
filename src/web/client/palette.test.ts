import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;

function truecolorKeys(): string[] {
  const source = readFileSync(join(here, '..', '..', 'ui', 'theme.ts'), 'utf8');
  const block = source.match(/^const truecolor = \{\n([\s\S]*?)^\};/m)?.[1];
  if (!block) throw new Error('theme.ts has no truecolor block');
  return [...block.matchAll(/^ {2}([A-Za-z]\w*):/gm)].map(m => m[1]!);
}

const kebab = (key: string) => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

describe('app.css palette', () => {
  it('has a --reika-* variable with a hex for every truecolor slot in theme.ts', () => {
    const keys = truecolorKeys();
    expect(keys.length).toBeGreaterThan(20);
    const css = readFileSync(join(here, 'app.css'), 'utf8');
    const missing = keys.filter(
      k => !new RegExp(`--reika-${kebab(k)}:\\s*#[0-9a-f]{6};`).test(css),
    );
    expect(missing).toEqual([]);
  });
});
