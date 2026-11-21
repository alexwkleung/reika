import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const cssFiles = readdirSync(here).filter(f => f.endsWith('.css'));

// A theme sets tokens (#1095); a literal written past them is a value no theme can reach.
const LITERALS = [
  /border-radius:\s*(?!50%)[0-9.]+(px|rem|em)/,
  /font-size:\s*[0-9.]+(px|rem)/,
  /rgba?\(0 0 0/,
  /#000\b/,
];

function rulesOutsideRoot(css: string): string[] {
  const withoutRoot = css.replace(/:root\s*\{[\s\S]*?\n\}/, '');
  return withoutRoot.split('\n');
}

describe('theme tokens', () => {
  it('leaves no radius, root-relative size or black shadow as a literal outside :root', () => {
    const found = cssFiles.flatMap(f =>
      rulesOutsideRoot(readFileSync(join(here, f), 'utf8'))
        .filter(line => LITERALS.some(re => re.test(line)) && !line.trim().startsWith('/*'))
        .map(line => `${f}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});
