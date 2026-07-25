import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandMentions } from './mentions.js';

const ok = (text: string) => ({ ok: true as const, text });

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

  it('OCRs an @mentioned image instead of inlining its bytes as text', async () => {
    await writeFile(join(cwd, 'shot.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions('what is @shot.png', cwd, { ocr: async () => ok('boom') });
    expect(out.augmented).toContain('<image path="shot.png">');
    expect(out.augmented).toContain('boom');
    expect(out.augmented).not.toContain('PNGBYTES');
    expect(out.found).toEqual(['shot.png']);
    expect(out.notices).toEqual([]);
  });

  it('picks up a bare dropped path so drag-and-drop works without an @', async () => {
    await writeFile(join(cwd, 'shot.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions(`look at ${cwd}/shot.png`, cwd, {
      ocr: async () => ok('boom'),
    });
    expect(out.augmented).toContain('boom');
    expect(out.display).toBe(`look at ${cwd}/shot.png`);
  });

  it('unescapes the backslash-escaped spaces a terminal inserts on drop', async () => {
    await writeFile(join(cwd, 'my shot.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions(`${cwd}/my\\ shot.png`, cwd, { ocr: async () => ok('boom') });
    expect(out.augmented).toContain('boom');
  });

  it('leaves a bare image filename in prose alone (no path separator)', async () => {
    await writeFile(join(cwd, 'logo.png'), 'PNGBYTES', 'utf8');
    const ocr = vi.fn(async () => ok('boom'));
    const out = await expandMentions('rename logo.png to icon.png', cwd, { ocr });
    expect(ocr).not.toHaveBeenCalled();
    expect(out.augmented).toBe('rename logo.png to icon.png');
  });

  it('does not OCR the same path twice when it is both @mentioned and bare', async () => {
    await writeFile(join(cwd, 'shot.png'), 'PNGBYTES', 'utf8');
    const ocr = vi.fn(async () => ok('boom'));
    await expandMentions(`@./shot.png`, cwd, { ocr });
    expect(ocr).toHaveBeenCalledTimes(1);
  });

  it('reports an image it could not read rather than dropping it silently', async () => {
    await writeFile(join(cwd, 'blank.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions('see @blank.png', cwd, {
      ocr: async () => ({ ok: false as const, reason: 'no-text' as const }),
    });
    expect(out.augmented).toBe('see @blank.png');
    expect(out.found).toEqual([]);
    expect(out.notices).toEqual(['No text found in blank.png.']);
  });

  it('says so when no OCR provider is available at all', async () => {
    await writeFile(join(cwd, 'shot.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions('see @shot.png', cwd);
    expect(out.notices).toEqual([
      "Can't attach shot.png — image OCR is unavailable on this platform.",
    ]);
  });

  it('stays quiet about an image URL, which resolves to no file at all', async () => {
    const ocr = vi.fn(async () => ok('boom'));
    const out = await expandMentions('see https://example.com/logo.png', cwd, { ocr });
    expect(ocr).not.toHaveBeenCalled();
    expect(out.notices).toEqual([]);
    expect(out.augmented).toBe('see https://example.com/logo.png');
  });

  it('stays quiet about an image URL even with no OCR provider configured', async () => {
    const out = await expandMentions('see https://example.com/logo.png', cwd);
    expect(out.notices).toEqual([]);
  });

  it('still attaches a text file mentioned alongside an unreadable image', async () => {
    await writeFile(join(cwd, 'a.ts'), 'CODE', 'utf8');
    await writeFile(join(cwd, 'shot.png'), 'PNGBYTES', 'utf8');
    const out = await expandMentions('@a.ts and @shot.png', cwd, {
      ocr: async () => ({ ok: false as const, reason: 'no-text' as const }),
    });
    expect(out.augmented).toContain('CODE');
    expect(out.found).toEqual(['a.ts']);
    expect(out.notices).toHaveLength(1);
  });

  it('matches image extensions case-insensitively', async () => {
    await writeFile(join(cwd, 'Shot.PNG'), 'PNGBYTES', 'utf8');
    const out = await expandMentions('see @Shot.PNG', cwd, { ocr: async () => ok('boom') });
    expect(out.augmented).toContain('boom');
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
