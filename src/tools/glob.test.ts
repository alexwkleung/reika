import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { globTool } from './glob.js';
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

  // 300 files split across two top-level dirs. Sorted lexicographically, the 200-path inline
  // page is entirely `aaa/` — the concentration that makes the dropped tail worth saving.
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
    // The inline page is all `aaa/`; the tail the model would otherwise never see is in the file.
    expect(payload).not.toContain('zzz/');
    const saved = (await readFile(locator!, 'utf8')).split('\n');
    expect(saved).toHaveLength(300);
    expect(saved.filter(p => p.startsWith('zzz/'))).toHaveLength(50);
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
