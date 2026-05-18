import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { globTool } from './glob.js';

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
