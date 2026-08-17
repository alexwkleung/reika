import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { globTool, sampleAcrossEntries } from './glob.js';
import { resetSpillDir } from './_spill.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-glob-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function setupFixture(): Promise<void> {
  await mkdir(join(cwd, 'src/agent'), { recursive: true });
  await mkdir(join(cwd, 'src/ui'), { recursive: true });
  await mkdir(join(cwd, 'tests'), { recursive: true });
  await writeFile(join(cwd, 'src/agent/loop.ts'), '', 'utf8');
  await writeFile(join(cwd, 'src/agent/loop.test.ts'), '', 'utf8');
  await writeFile(join(cwd, 'src/ui/App.tsx'), '', 'utf8');
  await writeFile(join(cwd, 'src/ui/App.test.tsx'), '', 'utf8');
  await writeFile(join(cwd, 'tests/integration.ts'), '', 'utf8');
  await writeFile(join(cwd, 'README.md'), '', 'utf8');
}

describe('globTool', () => {
  it('matches **/*.ts across all directories', async () => {
    await setupFixture();
    const result = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ignore() });
    expect(result.summary).toMatch(/Found \d+/);
    const paths = (result.payload ?? '').split('\n');
    expect(paths).toContain('src/agent/loop.ts');
    expect(paths).toContain('src/agent/loop.test.ts');
    expect(paths).toContain('tests/integration.ts');
    expect(paths).not.toContain('src/ui/App.tsx'); // .tsx, not .ts
  });

  it('matches **/*.test.* across all directories', async () => {
    await setupFixture();
    const result = await globTool.run({ pattern: '**/*.test.*' }, { cwd, ignore: ignore() });
    const paths = (result.payload ?? '').split('\n');
    expect(paths).toContain('src/agent/loop.test.ts');
    expect(paths).toContain('src/ui/App.test.tsx');
    expect(paths).not.toContain('src/agent/loop.ts'); // not a test file
  });

  it('scopes via path argument', async () => {
    await setupFixture();
    const result = await globTool.run(
      { pattern: '**/*.ts', path: 'src/agent' },
      { cwd, ignore: ignore() },
    );
    const paths = (result.payload ?? '').split('\n');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(p => !p.includes('tests/'))).toBe(true);
  });

  it('respects .gitignore', async () => {
    await setupFixture();
    const ig = ignore().add('**/*.test.ts\n**/*.test.tsx');
    const result = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ig });
    const paths = (result.payload ?? '').split('\n');
    expect(paths).toContain('src/agent/loop.ts');
    expect(paths).not.toContain('src/agent/loop.test.ts');
  });

  it('returns (no matches) when nothing matches', async () => {
    await setupFixture();
    const result = await globTool.run({ pattern: '**/*.xyz' }, { cwd, ignore: ignore() });
    expect(result.summary).toMatch(/Found 0/);
    expect(result.payload).toBe('(no matches)');
  });

  it('errors on empty pattern', async () => {
    const result = await globTool.run({ pattern: '' }, { cwd, ignore: ignore() });
    expect(result.summary).toMatch(/empty pattern/);
  });
});

describe('globTool spill (REIKA_SPILL)', () => {
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

  // 300 files split across two top-level dirs, lopsided 250/50. Sorted lexicographically the head
  // is entirely `aaa/`, which is what the sampled page has to fix and what the off-path still does.
  async function writeManyFiles(): Promise<void> {
    await mkdir(join(cwd, 'aaa'), { recursive: true });
    await mkdir(join(cwd, 'zzz'), { recursive: true });
    for (let i = 0; i < 250; i++) {
      await writeFile(join(cwd, 'aaa', `f${String(i).padStart(3, '0')}.ts`), '', 'utf8');
    }
    for (let i = 0; i < 50; i++) {
      await writeFile(join(cwd, 'zzz', `f${String(i).padStart(3, '0')}.ts`), '', 'utf8');
    }
  }

  it('saves the full sorted list and points at it', async () => {
    await writeManyFiles();
    const result = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ignore() });
    const payload = result.payload ?? '';
    const locator = /saved to (\S+\.txt)/.exec(payload)?.[1];
    expect(locator).toBeTruthy();
    spillDirs.push(dirname(locator!));

    expect(result.summary).toBe('Found 300 file(s) matching **/*.ts — showing 200');
    expect(payload).toContain('Showing 200 of 300 paths');
    expect(payload).toContain('Sampled evenly across all 2 top-level entries');
    // The page reaches both entries — the lexicographic head would have been 200 files of `aaa/`
    // with `zzz/` absent entirely. `zzz` has only 50 paths, so it takes 50 slots and `aaa` the rest.
    const page = payload.slice(0, payload.indexOf('\n\n(Showing')).split('\n');
    expect(page.filter(p => p.startsWith('zzz/'))).toHaveLength(50);
    expect(page.filter(p => p.startsWith('aaa/'))).toHaveLength(150);
    // Grouped, not interleaved: one contiguous run per entry.
    expect(page.findIndex(p => p.startsWith('zzz/'))).toBe(150);
    // The complete sorted list survives regardless of what the page shows — this is what makes
    // sampling safe, since sorted-order questions stay answerable from the artifact.
    const saved = (await readFile(locator!, 'utf8')).split('\n');
    expect(saved).toHaveLength(300);
    expect(saved[0]).toBe('aaa/f000.ts');
    expect(saved[saved.length - 1]).toBe('zzz/f049.ts');
  });

  it('is byte-identical to the capped result when the flag is off', async () => {
    await writeManyFiles();
    const on = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ignore() });
    spillDirs.push(dirname(/saved to (\S+\.txt)/.exec(on.payload ?? '')![1]));
    delete process.env.REIKA_SPILL;
    const off = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ignore() });
    expect(off.summary).toBe('Found 300+ file(s) matching **/*.ts');
    expect(off.payload).not.toContain('saved to');
    expect((off.payload ?? '').split('\n')).toHaveLength(200);
  });

  it('leaves an under-cap result untouched', async () => {
    await setupFixture();
    const result = await globTool.run({ pattern: '**/*.ts' }, { cwd, ignore: ignore() });
    expect(result.summary).toMatch(/^Found \d+ file\(s\)/);
    expect(result.payload).not.toContain('saved to');
  });
});

describe('sampleAcrossEntries', () => {
  const tree = (entry: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${entry}/f${String(i).padStart(3, '0')}.ts`);

  it('represents every entry before any entry gets a second path', () => {
    const sorted = [...tree('a', 100), ...tree('b', 100), ...tree('c', 1)].sort();
    const { page, entries, unreached } = sampleAcrossEntries(sorted, 5);
    expect(entries).toBe(3);
    expect(unreached).toBe(0);
    // c has only one path, so the two leftover slots go to a and b.
    expect(page).toEqual(['a/f000.ts', 'a/f001.ts', 'b/f000.ts', 'b/f001.ts', 'c/f000.ts']);
  });

  it('emits grouped, not interleaved — allocation is round-robin, output is contiguous', () => {
    const sorted = [...tree('a', 10), ...tree('b', 10)].sort();
    const { page } = sampleAcrossEntries(sorted, 6);
    expect(page).toEqual([
      'a/f000.ts',
      'a/f001.ts',
      'a/f002.ts',
      'b/f000.ts',
      'b/f001.ts',
      'b/f002.ts',
    ]);
  });

  it('redistributes slots from exhausted entries instead of wasting them', () => {
    const sorted = [...tree('a', 1), ...tree('b', 1), ...tree('c', 20)].sort();
    const { page } = sampleAcrossEntries(sorted, 10);
    expect(page).toHaveLength(10);
    expect(page.filter(p => p.startsWith('c/'))).toHaveLength(8);
  });

  it('reports entries it could not reach when there is less room than entries', () => {
    const sorted = Array.from({ length: 300 }, (_, i) => `e${String(i).padStart(3, '0')}/f.ts`);
    const { page, entries, unreached } = sampleAcrossEntries(sorted, 200);
    expect(entries).toBe(300);
    expect(unreached).toBe(100);
    expect(page).toHaveLength(200);
    expect(page[0]).toBe('e000/f.ts');
  });

  it('treats a root-level file as its own entry', () => {
    const sorted = ['README.md', ...tree('src', 50)].sort();
    const { page } = sampleAcrossEntries(sorted, 4);
    expect(page).toContain('README.md');
    expect(page.filter(p => p.startsWith('src/'))).toHaveLength(3);
  });

  it('returns everything when the limit exceeds the result', () => {
    const sorted = [...tree('a', 2), ...tree('b', 2)].sort();
    expect(sampleAcrossEntries(sorted, 100).page).toEqual(sorted);
  });
});
