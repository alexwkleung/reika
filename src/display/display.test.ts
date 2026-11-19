import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;

// The browser bundles these files, so the bundle test only sees the ones the page reaches today.
// This holds the whole directory to the rule, so a file the page imports tomorrow already fits it.
const FORBIDDEN = [/^node:/, /^ink($|\/)/, /^chalk($|\/)/, /^react($|\/)/, /^\.\.\/ui\//];

function importsOf(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(
    m => m[1]!,
  );
}

describe('src/display', () => {
  const files = readdirSync(here).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  it('holds no component files', () => {
    expect(files.filter(f => f.endsWith('.tsx'))).toEqual([]);
  });

  it('imports no Node built-in, Ink, chalk, React or ui/ module', () => {
    const bad = files.flatMap(f =>
      importsOf(readFileSync(join(here, f), 'utf8'))
        .filter(spec => FORBIDDEN.some(re => re.test(spec)))
        .map(spec => `${f}: ${spec}`),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});
