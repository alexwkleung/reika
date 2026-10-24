import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBashFileRead, traceBashRead, traceReadPath } from './bashread.js';

describe('parseBashFileRead', () => {
  it.each([
    ['cat src/a.ts', { path: 'src/a.ts', range: { from: 1 } }],
    ['cat -n src/a.ts', { path: 'src/a.ts', range: { from: 1 } }],
    ['cat "my file.ts"', { path: 'my file.ts', range: { from: 1 } }],
    ['head src/a.ts', { path: 'src/a.ts', range: { from: 1, count: 10 } }],
    ['head -n 50 src/a.ts', { path: 'src/a.ts', range: { from: 1, count: 50 } }],
    ['head -50 src/a.ts', { path: 'src/a.ts', range: { from: 1, count: 50 } }],
    ['head --lines=5 src/a.ts', { path: 'src/a.ts', range: { from: 1, count: 5 } }],
    ['tail -n 30 src/a.ts', { path: 'src/a.ts', range: { last: 30 } }],
    ['tail -n +40 src/a.ts', { path: 'src/a.ts', range: { from: 40 } }],
    ["sed -n '80,320p' src/config.ts", { path: 'src/config.ts', range: { from: 80, count: 241 } }],
    ["sed -n '12p' src/a.ts", { path: 'src/a.ts', range: { from: 12, count: 1 } }],
    ["sed -n '40,$p' src/a.ts", { path: 'src/a.ts', range: { from: 40 } }],
  ])('reads %s', (cmd, expected) => {
    expect(parseBashFileRead(cmd)).toEqual(expected);
  });

  // Anything that is not one command reading one file is not counted: under-counting costs a loop
  // caught later, miscounting costs inspection withdrawn from a model doing real work.
  it.each([
    'cat a.ts b.ts',
    'cat a.ts | head -20',
    'cat a.ts > b.ts',
    'cat a.ts 2>/dev/null',
    'cd src && cat a.ts',
    'cat $(ls *.ts)',
    'cat',
    'cat -- a.ts',
    'head -c 100 a.ts',
    'head -n +5 a.ts',
    "sed -i 's/x/y/' a.ts",
    "sed -n '/foo/p' a.ts",
    "sed -n '20,10p' a.ts",
    "sed '1,10p' a.ts",
    'grep -n foo a.ts',
    'wc -l a.ts',
  ])('ignores %s', cmd => {
    expect(parseBashFileRead(cmd)).toBeUndefined();
  });
});

describe('traceBashRead', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'reika-bashread-unit-'));
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  writeFileSync(join(cwd, 'a.ts'), text);
  const hash = createHash('sha1').update(text).digest('hex');

  it('hashes the whole file the way read does, so the two share one file entry', async () => {
    expect(await traceBashRead('cat a.ts', cwd)).toEqual({
      path: 'a.ts',
      offset: 1,
      limit: undefined,
      hash,
    });
  });

  it('places a tail range from the file length', async () => {
    expect(await traceBashRead('tail -n 30 a.ts', cwd)).toMatchObject({ offset: 71, limit: 30 });
  });

  it('files an absolute path inside the project under its relative key', async () => {
    expect(await traceBashRead(`cat ${join(cwd, 'a.ts')}`, cwd)).toMatchObject({ path: 'a.ts' });
    expect(traceReadPath(cwd, join(cwd, 'src/x.ts'))).toBe('src/x.ts');
    expect(traceReadPath(cwd, '/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });

  it('skips a file it cannot read', async () => {
    expect(await traceBashRead('cat missing.ts', cwd)).toBeUndefined();
  });
});
