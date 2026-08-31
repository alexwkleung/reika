import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { listTool } from './list.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-list-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

// A repo shaped like the one in #177: build output under a gitignored `release/`.
async function setupFixture(): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'release/mac-arm64'), { recursive: true });
  await mkdir(join(cwd, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{}', 'utf8');
  await writeFile(join(cwd, 'src/index.ts'), '', 'utf8');
  await writeFile(join(cwd, 'release/App-1.0.0.dmg'), '', 'utf8');
  await writeFile(join(cwd, 'release/latest-mac.yml'), '', 'utf8');
  await writeFile(join(cwd, 'release/mac-arm64/App'), '', 'utf8');
  await writeFile(join(cwd, 'node_modules/pkg/index.js'), '', 'utf8');
}

const ig = () => ignore().add(['release/', 'node_modules/']);

describe('listTool', () => {
  it('lists entries relative to cwd', async () => {
    await setupFixture();
    const result = await listTool.run({}, { cwd, ignore: ig() });
    const entries = (result.payload ?? '').split('\n');
    expect(entries).toContain('package.json');
    expect(entries).toContain('src/');
    expect(entries).not.toContain('release/');
  });

  it('reports how many entries the ignore rules hid', async () => {
    await setupFixture();
    const result = await listTool.run({}, { cwd, ignore: ig() });
    // release/ (gitignore) and node_modules/ (build-dir rule).
    expect(result.summary).toMatch(/2 hidden by \.gitignore/);
  });

  it('lists inside a gitignored directory when it is the explicit target', async () => {
    await setupFixture();
    const result = await listTool.run({ path: 'release' }, { cwd, ignore: ig() });
    const entries = (result.payload ?? '').split('\n');
    expect(entries).toContain('release/App-1.0.0.dmg');
    expect(entries).toContain('release/latest-mac.yml');
    expect(entries).toContain('release/mac-arm64/');
    expect(result.summary).toMatch(/^Listed 3 entries in release$/);
  });

  it('lists inside a build directory when it is the explicit target', async () => {
    await setupFixture();
    const result = await listTool.run({ path: 'node_modules/pkg' }, { cwd, ignore: ig() });
    expect(result.payload).toContain('node_modules/pkg/index.js');
  });

  it('recurses to the requested depth', async () => {
    await setupFixture();
    const result = await listTool.run({ path: 'release', depth: 2 }, { cwd, ignore: ig() });
    expect(result.payload).toContain('release/mac-arm64/App');
  });

  it('says a directory is empty rather than returning a blank payload', async () => {
    await mkdir(join(cwd, 'empty'), { recursive: true });
    const result = await listTool.run({ path: 'empty' }, { cwd, ignore: ig() });
    expect(result.summary).toBe('Listed 0 entries in empty');
    expect(result.payload).toContain('empty directory');
  });

  it('explains a zero listing caused by the ignore rules', async () => {
    await mkdir(join(cwd, 'pkgs/vendor'), { recursive: true });
    await writeFile(join(cwd, 'pkgs/notes.log'), '', 'utf8');
    const result = await listTool.run(
      { path: 'pkgs' },
      { cwd, ignore: ignore().add(['*.log', 'pkgs/vendor/']) },
    );
    expect(result.summary).toBe(
      'Listed 0 entries in pkgs (2 hidden by .gitignore/build-dir rules)',
    );
    expect(result.payload).toMatch(/hidden by \.gitignore/);
  });

  it('names a file as a file instead of listing zero entries', async () => {
    await setupFixture();
    const result = await listTool.run({ path: 'package.json' }, { cwd, ignore: ig() });
    expect(result.summary).toBe('List failed: package.json is a file, not a directory');
    expect(result.payload).toContain('read with path="package.json"');
  });

  it('reports a missing path', async () => {
    const result = await listTool.run({ path: 'nope' }, { cwd, ignore: ig() });
    expect(result.summary).toBe('List failed: path not found: nope');
  });

  it('lists a directory outside cwd under the path the model gave', async () => {
    const other = await mkdtemp(join(tmpdir(), 'reika-list-other-'));
    await writeFile(join(other, 'notes.md'), '', 'utf8');
    try {
      const result = await listTool.run({ path: other }, { cwd, ignore: ig() });
      expect(result.payload).toContain(join(other, 'notes.md'));
      // The summary names the directory the same way the entries do — never a `../..` chain.
      expect(result.summary).toBe(`Listed 1 entries in ${other}`);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
