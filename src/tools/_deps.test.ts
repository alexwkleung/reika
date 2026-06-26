import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPackageNames, surfaceImportedDeps } from './_deps.js';

describe('extractPackageNames', () => {
  it('pulls bare specifiers from every import form', () => {
    const src = [
      `import { z } from 'zod';`,
      `import express from "express";`,
      `import 'side-effect';`,
      `export { foo } from 'bar';`,
      `const fs = require('graceful-fs');`,
      `const m = await import('dynamic-pkg');`,
    ].join('\n');
    expect(extractPackageNames(src).sort()).toEqual(
      ['bar', 'dynamic-pkg', 'express', 'graceful-fs', 'side-effect', 'zod'].sort(),
    );
  });

  it('skips relative, absolute, and node: builtins', () => {
    const src = [
      `import a from './local';`,
      `import b from '../up';`,
      `import c from '/abs';`,
      `import d from 'node:fs';`,
    ].join('\n');
    expect(extractPackageNames(src)).toEqual([]);
  });

  it('normalizes subpaths and scoped packages to the package root', () => {
    const src = [`import { x } from 'zod/v4';`, `import y from '@scope/pkg/sub/deep';`].join('\n');
    expect(extractPackageNames(src).sort()).toEqual(['@scope/pkg', 'zod'].sort());
  });
});

describe('surfaceImportedDeps', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-deps-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function addPkg(name: string, pkgJson: object, files: Record<string, string>) {
    const dir = join(cwd, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkgJson), 'utf8');
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
  }

  it('surfaces the installed type entry of an imported dep', async () => {
    await addPkg(
      'cool',
      { types: 'index.d.ts' },
      {
        'index.d.ts': 'export declare function doThing(n: number): string;',
      },
    );
    const out = await surfaceImportedDeps({ cwd }, `import { doThing } from 'cool';`);
    expect(out).toContain('cool');
    expect(out).toContain('node_modules/cool/index.d.ts');
    expect(out).toContain('doThing(n: number): string');
  });

  it('resolves types via the exports map when no top-level types field exists', async () => {
    await addPkg(
      'exp',
      { exports: { '.': { import: { types: './dist/api.d.ts' } } } },
      { 'dist/api.d.ts': 'export type Shape = { id: string };' },
    );
    const out = await surfaceImportedDeps({ cwd }, `import { Shape } from 'exp';`);
    expect(out).toContain('node_modules/exp/dist/api.d.ts');
    expect(out).toContain('type Shape = { id: string }');
  });

  it('returns nothing for a dep that ships no types', async () => {
    await addPkg('plain', { main: 'index.js' }, { 'index.js': 'module.exports = {};' });
    expect(await surfaceImportedDeps({ cwd }, `import x from 'plain';`)).toBeUndefined();
  });

  it('returns nothing when the dep is not installed', async () => {
    expect(await surfaceImportedDeps({ cwd }, `import x from 'ghost';`)).toBeUndefined();
  });

  it('grounds each dep at most once per turn via resolvedDeps', async () => {
    await addPkg('once', { types: 'index.d.ts' }, { 'index.d.ts': 'export const v: number;' });
    const resolvedDeps = new Set<string>();
    const first = await surfaceImportedDeps({ cwd, resolvedDeps }, `import { v } from 'once';`);
    const second = await surfaceImportedDeps({ cwd, resolvedDeps }, `import { v } from 'once';`);
    expect(first).toContain('once');
    expect(second).toBeUndefined();
  });

  it('does not re-probe a dep with no types after the first miss', async () => {
    await addPkg('plain', { main: 'index.js' }, { 'index.js': '' });
    const resolvedDeps = new Set<string>();
    await surfaceImportedDeps({ cwd, resolvedDeps }, `import x from 'plain';`);
    expect(resolvedDeps.has('plain')).toBe(true);
  });

  it('follows a barrel re-export one hop to reach the real declarations', async () => {
    await addPkg(
      'barrel',
      { types: 'index.d.ts' },
      {
        'index.d.ts': `export * from './impl.js';`,
        'impl.d.ts': 'export declare function real(x: number): boolean;',
      },
    );
    const out = await surfaceImportedDeps({ cwd }, `import { real } from 'barrel';`);
    expect(out).toContain('real(x: number): boolean');
    expect(out).toContain('// from ./impl.js');
  });

  it('keeps a mixed entry’s own declarations alongside followed re-exports', async () => {
    await addPkg(
      'mixed',
      { types: 'index.d.ts' },
      {
        'index.d.ts': `export declare const own: string;\nexport * from './more.js';`,
        'more.d.ts': 'export declare function extra(): void;',
      },
    );
    const out = await surfaceImportedDeps({ cwd }, `import { own } from 'mixed';`);
    expect(out).toContain('export declare const own: string');
    expect(out).toContain('extra(): void');
  });

  it('follows only one hop — a barrel of barrels is not chased recursively', async () => {
    await addPkg(
      'deep',
      { types: 'index.d.ts' },
      {
        'index.d.ts': `export * from './a.js';`,
        'a.d.ts': `export * from './b.js';`,
        'b.d.ts': 'export declare function buried(): void;',
      },
    );
    const out = await surfaceImportedDeps({ cwd }, `import x from 'deep';`);
    expect(out).toContain(`export * from './b.js'`); // a's line is shown
    expect(out).not.toContain('buried'); // but b is never read
  });

  it('condenses a long .d.ts to its export lines', async () => {
    const body = Array.from({ length: 100 }, (_, i) => `// filler ${i}`).join('\n');
    await addPkg(
      'big',
      { types: 'index.d.ts' },
      {
        'index.d.ts': `${body}\nexport declare function a(): void;\nexport declare function b(): void;`,
      },
    );
    const out = await surfaceImportedDeps({ cwd }, `import { a } from 'big';`);
    expect(out).toContain('export declare function a(): void');
    expect(out).not.toContain('filler 50');
  });
});
