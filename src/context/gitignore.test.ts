import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGitignore, scopeGitignore } from './gitignore.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-gitignore-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('scopeGitignore', () => {
  it('re-roots unanchored patterns to any depth below the directory', () => {
    expect(scopeGitignore('pkg', '*.log\ntmp/')).toEqual(['pkg/**/*.log', 'pkg/**/tmp/']);
  });

  it('anchors patterns that contain a slash to the directory', () => {
    expect(scopeGitignore('pkg', '/gen\nsrc/out\n**/deep')).toEqual([
      'pkg/gen',
      'pkg/src/out',
      'pkg/**/deep',
    ]);
  });

  it('keeps negation, drops comments and blanks, trims unescaped trailing spaces', () => {
    expect(scopeGitignore('pkg', '# c\n\n!keep.log  \n  \r\n')).toEqual(['!pkg/**/keep.log']);
  });
});

describe('loadGitignore', () => {
  it('applies a nested .gitignore only inside its own directory', async () => {
    await mkdir(join(cwd, 'pkg', 'deep'), { recursive: true });
    await writeFile(join(cwd, 'pkg', '.gitignore'), '*.gen\n', 'utf8');
    const ig = await loadGitignore(cwd);
    expect(ig.ignores('pkg/a.gen')).toBe(true);
    expect(ig.ignores('pkg/deep/a.gen')).toBe(true);
    expect(ig.ignores('a.gen')).toBe(false);
    expect(ig.ignores('other/a.gen')).toBe(false);
  });

  it('lets a nested negation re-include what the root ignored', async () => {
    await mkdir(join(cwd, 'pkg'), { recursive: true });
    await writeFile(join(cwd, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(cwd, 'pkg', '.gitignore'), '!keep.log\n', 'utf8');
    const ig = await loadGitignore(cwd);
    expect(ig.ignores('pkg/keep.log')).toBe(false);
    expect(ig.ignores('pkg/other.log')).toBe(true);
    expect(ig.ignores('keep.log')).toBe(true);
  });

  it('does not read a .gitignore inside an already-ignored or skipped directory', async () => {
    await mkdir(join(cwd, 'vendor'), { recursive: true });
    await mkdir(join(cwd, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(cwd, '.gitignore'), 'vendor/\n', 'utf8');
    // Git never consults these, so a negation here must not leak out.
    await writeFile(join(cwd, 'vendor', '.gitignore'), '!*\n', 'utf8');
    await writeFile(join(cwd, 'node_modules', 'x', '.gitignore'), '!*\n', 'utf8');
    const ig = await loadGitignore(cwd);
    expect(ig.ignores('vendor/a.ts')).toBe(true);
  });

  it('spends the directory cap breadth-first, so shallow nested files win over deep ones', async () => {
    await mkdir(join(cwd, 'a'), { recursive: true });
    await mkdir(join(cwd, 'b', 'deep'), { recursive: true });
    await mkdir(join(cwd, 'c'), { recursive: true });
    await writeFile(join(cwd, 'b', 'deep', '.gitignore'), '*.deep\n', 'utf8');
    await writeFile(join(cwd, 'c', '.gitignore'), '*.shallow\n', 'utf8');
    // Root, a, b, c fit in four visits; b/deep is listed after every top-level directory even
    // though `b` sorts before `c`, so it is the one the cap cuts.
    const ig = await loadGitignore(cwd, { depth: 8, files: 200, dirs: 4 });
    expect(ig.ignores('c/x.shallow')).toBe(true);
    expect(ig.ignores('b/deep/x.deep')).toBe(false);
    const full = await loadGitignore(cwd);
    expect(full.ignores('b/deep/x.deep')).toBe(true);
  });

  it('stops descending at the depth cap', async () => {
    await mkdir(join(cwd, 'l1', 'l2'), { recursive: true });
    await writeFile(join(cwd, 'l1', '.gitignore'), '*.one\n', 'utf8');
    await writeFile(join(cwd, 'l1', 'l2', '.gitignore'), '*.two\n', 'utf8');
    const ig = await loadGitignore(cwd, { depth: 2, files: 200, dirs: 2000 });
    expect(ig.ignores('l1/x.one')).toBe(true);
    expect(ig.ignores('l1/l2/x.two')).toBe(false);
  });
});
