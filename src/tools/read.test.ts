import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { readTool } from './read.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-read-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const ctx = () => ({ cwd, ignore: ignore() });

describe('readTool', () => {
  it('appends a continuation marker pointing at the next offset when truncated', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line${i + 1}`);
    await writeFile(join(cwd, 'big.txt'), lines.join('\n'), 'utf8');
    const result = await readTool.run({ path: 'big.txt' }, ctx());
    expect(result.payload).toContain('200 more lines below');
    expect(result.payload).toContain('offset=301');
    expect(result.summary).toMatch(/lines 1-300 of 500/);
  });

  it('omits the marker when the read reaches EOF', async () => {
    await writeFile(join(cwd, 'small.txt'), ['a', 'b', 'c'].join('\n'), 'utf8');
    const result = await readTool.run({ path: 'small.txt' }, ctx());
    expect(result.payload).not.toContain('more line');
    expect(result.summary).toMatch(/lines 1-3 of 3/);
  });

  it('does not claim a phantom extra line for files ending in a newline', async () => {
    await writeFile(join(cwd, 'nl.txt'), 'a\nb\nc\n', 'utf8');
    const result = await readTool.run({ path: 'nl.txt' }, ctx());
    expect(result.summary).toMatch(/of 3/);
    expect(result.payload).not.toContain('more line');
  });

  it('explains a past-EOF read instead of returning an empty payload', async () => {
    await writeFile(join(cwd, 'short.txt'), ['a', 'b'].join('\n'), 'utf8');
    const result = await readTool.run({ path: 'short.txt', offset: 50 }, ctx());
    expect(result.summary).toMatch(/past end of file/);
    expect(result.payload).toContain('past the end');
    expect(result.payload).not.toBe('');
  });

  it('paging with offset lands on the right lines and continues correctly', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    await writeFile(join(cwd, 'p.txt'), lines.join('\n'), 'utf8');
    const result = await readTool.run({ path: 'p.txt', offset: 5, limit: 3 }, ctx());
    expect(result.payload).toContain('    5│L5');
    expect(result.payload).toContain('    7│L7');
    expect(result.payload).toContain('offset=8');
    expect(result.summary).toMatch(/lines 5-7 of 10/);
  });
});
