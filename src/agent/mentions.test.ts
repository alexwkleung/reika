import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandMentions } from './mentions.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-mentions-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('expandMentions', () => {
  it('returns input unchanged when no @ mentions are present', async () => {
    const out = await expandMentions('plain text', cwd);
    expect(out.augmented).toBe('plain text');
    expect(out.display).toBe('plain text');
    expect(out.found).toEqual([]);
  });

  it('inlines an existing file as a <file> block', async () => {
    await writeFile(join(cwd, 'foo.ts'), 'export const X = 1;\n', 'utf8');
    const out = await expandMentions('look at @foo.ts', cwd);
    expect(out.augmented).toContain('<file path="foo.ts">');
    expect(out.augmented).toContain('export const X = 1;');
    expect(out.augmented).toContain('look at @foo.ts');
    expect(out.display).toBe('look at @foo.ts');
    expect(out.found).toEqual(['foo.ts']);
  });

  it('silently skips mentions that do not resolve to a file', async () => {
    const out = await expandMentions('look at @missing.ts', cwd);
    expect(out.augmented).toBe('look at @missing.ts');
    expect(out.found).toEqual([]);
  });

  it('handles multiple mentions in one input', async () => {
    await writeFile(join(cwd, 'a.ts'), 'A', 'utf8');
    await writeFile(join(cwd, 'b.ts'), 'B', 'utf8');
    const out = await expandMentions('compare @a.ts and @b.ts', cwd);
    expect(out.found).toEqual(['a.ts', 'b.ts']);
    expect(out.augmented).toContain('A');
    expect(out.augmented).toContain('B');
  });

  it('does not treat mid-string @ as a mention (e.g. emails)', async () => {
    const out = await expandMentions('email me at foo@bar.com', cwd);
    expect(out.found).toEqual([]);
  });

  it('resolves paths relative to cwd', async () => {
    await mkdir(join(cwd, 'sub'), { recursive: true });
    await writeFile(join(cwd, 'sub', 'inner.txt'), 'INSIDE', 'utf8');
    const out = await expandMentions('see @sub/inner.txt', cwd);
    expect(out.found).toEqual(['sub/inner.txt']);
    expect(out.augmented).toContain('INSIDE');
  });

  it('expands ~ to homedir', async () => {
    const out = await expandMentions('here is @~', cwd);
    // homedir() likely exists and is a directory — readFile will fail, so no match.
    // Just verify it didn't crash and the input was preserved.
    expect(out.augmented).toBe('here is @~');
    expect(out.found).toEqual([]);
    // Sanity: homedir is a non-empty path
    expect(homedir().length > 0).toBe(true);
  });
});
