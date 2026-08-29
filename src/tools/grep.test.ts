import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { grepTool } from './grep.js';
import { resetSpillDir } from './_spill.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-grep-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('grepTool', () => {
  it('returns the matching line plus surrounding context', async () => {
    await writeFile(
      join(cwd, 'a.css'),
      ['before2', 'before1', '.target {', '  color: red;', '}', 'after2'].join('\n'),
      'utf8',
    );
    const result = await grepTool.run({ pattern: '\\.target' }, { cwd, ignore: ignore() });
    const lines = (result.payload ?? '').split('\n');
    // Match line uses ':'; context lines use '-'. The body (color: red;) must be present.
    expect(lines).toContain('a.css:3: .target {');
    expect(lines).toContain('a.css:1- before2');
    expect(lines).toContain('a.css:4-   color: red;');
    expect(lines).toContain('a.css:5- }');
  });

  it('merges adjacent matches into one block without repeating lines', async () => {
    await writeFile(join(cwd, 'b.txt'), ['x', 'hit', 'mid', 'hit', 'y'].join('\n'), 'utf8');
    const result = await grepTool.run({ pattern: 'hit' }, { cwd, ignore: ignore() });
    const payload = result.payload ?? '';
    // Two matches within 2 lines collapse into a single contiguous block (no '--' separator).
    expect(payload).not.toContain('--');
    expect(result.summary).toMatch(/Found 2 matches/);
    // 'mid' appears once as shared context, not duplicated.
    expect(payload.match(/ mid$/gm)?.length).toBe(1);
  });

  it('separates non-adjacent blocks with --', async () => {
    const filler = Array.from({ length: 10 }, (_, i) => `pad${i}`);
    await writeFile(join(cwd, 'c.txt'), ['hit', ...filler, 'hit'].join('\n'), 'utf8');
    const result = await grepTool.run({ pattern: 'hit' }, { cwd, ignore: ignore() });
    expect(result.payload ?? '').toContain('\n--\n');
  });

  it('truncates very long lines', async () => {
    await writeFile(join(cwd, 'd.txt'), 'match ' + 'z'.repeat(500), 'utf8');
    const result = await grepTool.run({ pattern: 'match' }, { cwd, ignore: ignore() });
    expect(result.payload ?? '').toContain('…');
  });

  it('accepts glob-style include filters ("*.css", "**/*.css")', async () => {
    await mkdir(join(cwd, 'nested'), { recursive: true });
    await writeFile(join(cwd, 'nested', 'styles.css'), '.kana-sidebar { color: red; }', 'utf8');
    await writeFile(join(cwd, 'nested', 'app.ts'), 'const sidebar = 1;', 'utf8');
    for (const include of ['*.css', '**/*.css', '.css']) {
      const result = await grepTool.run({ pattern: 'sidebar', include }, { cwd, ignore: ignore() });
      expect(result.summary, `include=${include}`).toMatch(/Found 1 matches/);
      expect(result.payload ?? '').toContain('styles.css');
    }
  });

  it('reports a missing path instead of 0 matches', async () => {
    const result = await grepTool.run(
      { pattern: 'sidebar', path: 'no/such/dir' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toContain('path not found: no/such/dir');
    expect(result.summary).not.toContain('Found 0');
  });

  it('says so when the include filter excluded every file', async () => {
    await writeFile(join(cwd, 'a.txt'), 'sidebar', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'sidebar', 'utf8');
    const result = await grepTool.run(
      { pattern: 'sidebar', include: '*.css' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toContain('include "*.css" matched none of the 2 file(s)');
  });
});

describe('grepTool explicit ignored target', () => {
  it('searches inside a gitignored directory when the path names it', async () => {
    await mkdir(join(cwd, 'release'), { recursive: true });
    await writeFile(join(cwd, 'release/latest-mac.yml'), 'version: 1.0.0', 'utf8');
    const ig = ignore().add(['release/']);
    const scoped = await grepTool.run({ pattern: 'version', path: 'release' }, { cwd, ignore: ig });
    expect(scoped.summary).toBe('Found 1 matches for /version/');
    // Unchanged from the repo root: the ignore file still applies when it wasn't the target.
    const root = await grepTool.run({ pattern: 'version' }, { cwd, ignore: ig });
    expect(root.summary).toBe('Found 0 matches for /version/');
  });
});

describe('grepTool spill (REIKA_SPILL)', () => {
  const spillDirs: string[] = [];

  beforeEach(() => {
    resetSpillDir();
    process.env.REIKA_SPILL = '1';
  });

  afterEach(async () => {
    delete process.env.REIKA_SPILL;
    resetSpillDir();
    for (const d of spillDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  // 7 files x `perFile` matches. Matches are spaced wider than 2xCONTEXT so every one is its own
  // block (adjacent ones would merge into a single range), and the per-file count puts the
  // 100-match inline boundary in the middle of a file rather than on a file edge. The default
  // total (210) sits under SPILL_MAX_MATCHES so the summary can report an exact count.
  async function writeManyMatches(perFile = 30): Promise<void> {
    for (let f = 0; f < 7; f++) {
      const lines: string[] = [];
      for (let i = 0; i < perFile; i++) {
        lines.push('needle', 'pad', 'pad', 'pad', 'pad', 'pad', 'pad');
      }
      await writeFile(join(cwd, `f${f}.txt`), lines.join('\n'), 'utf8');
    }
  }

  it('caps the inline page but saves the full result and points at it', async () => {
    await writeManyMatches();
    const result = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    const payload = result.payload ?? '';
    const locator = /saved to (\S+\.txt)/.exec(payload)?.[1];
    expect(locator).toBeTruthy();
    spillDirs.push(dirname(locator!));

    // The summary reports the honest total, not the "100+" floor the walk used to stop at.
    expect(result.summary).toBe('Found 210 matches for /needle/ — showing 100');
    // The inline page is bounded; the spill file holds everything.
    const inlineHits = payload.split('\n').filter(l => /:\d+: /.test(l)).length;
    expect(inlineHits).toBe(100);
    const saved = await readFile(locator!, 'utf8');
    expect(saved.split('\n').filter(l => /:\d+: /.test(l)).length).toBe(210);
    // The inline page is a true prefix of the saved result — no reformatting between them.
    expect(saved.startsWith(payload.slice(0, payload.indexOf('\n\n(Showing')))).toBe(true);
  });

  it('reports a floor rather than a false total once collection hits the ceiling', async () => {
    await writeManyMatches(60); // 420 > SPILL_MAX_MATCHES
    const result = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    const payload = result.payload ?? '';
    spillDirs.push(dirname(/saved to (\S+\.txt)/.exec(payload)![1]));
    // The walk stopped early, so the count is honest about being a floor — claiming 300 exactly
    // would assert something the search never established.
    expect(result.summary).toBe('Found 300+ matches for /needle/ — showing 100');
    expect(payload).toContain('Showing 100 of 300+ matches');
  });

  it('never cuts a context block in half', async () => {
    await writeManyMatches();
    const result = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    const payload = result.payload ?? '';
    spillDirs.push(dirname(/saved to (\S+\.txt)/.exec(payload)![1]));
    const body = payload.slice(0, payload.indexOf('\n\n(Showing'));
    // Each emitted block is `pad / pad / needle / pad / pad`; a cut mid-block would leave a
    // trailing context line with no match line after it.
    for (const block of body.split('\n--\n')) {
      expect(block.split('\n').filter(l => /:\d+: /.test(l)).length).toBe(1);
    }
  });

  it('is byte-identical to the capped result when the flag is off', async () => {
    await writeManyMatches();
    const on = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    spillDirs.push(dirname(/saved to (\S+\.txt)/.exec(on.payload ?? '')![1]));
    delete process.env.REIKA_SPILL;
    const off = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    expect(off.summary).toBe('Found 100+ matches for /needle/');
    expect(off.payload).not.toContain('saved to');
  });

  it('leaves an under-cap result untouched', async () => {
    await writeFile(join(cwd, 'a.txt'), ['needle', 'x', 'needle'].join('\n'), 'utf8');
    const result = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    expect(result.summary).toBe('Found 2 matches for /needle/');
    expect(result.payload).not.toContain('saved to');
  });
});
