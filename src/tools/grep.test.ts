import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { grepTool } from './grep.js';

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
});
