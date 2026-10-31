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
    // #810: one leading cd hop, and a head | tail window.
    ['cd src && cat a.ts', { path: 'a.ts', range: { from: 1 }, dir: 'src' }],
    ['cd /repo && tail -n 5 src/a.ts', { path: 'src/a.ts', range: { last: 5 }, dir: '/repo' }],
    ['cd "my dir" && cat a.ts', { path: 'a.ts', range: { from: 1 }, dir: 'my dir' }],
    ['head -n 110 src/a.ts | tail -n 30', { path: 'src/a.ts', range: { last: 30, within: 110 } }],
    ['head -100 a.ts | tail -10', { path: 'a.ts', range: { last: 10, within: 100 } }],
    [
      'cd /repo && head -n 105 src/a.ts | tail -n 15',
      { path: 'src/a.ts', range: { last: 15, within: 105 }, dir: '/repo' },
    ],
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
    'cd src; cat a.ts',
    'cd src || cat a.ts',
    'cd src && cd lib && cat a.ts',
    'cd - && cat a.ts',
    'cd $X && cat a.ts',
    'cd "$X" && cat a.ts',
    'cd a b && cat c.ts',
    'cd src && grep -n foo a.ts',
    'cd src',
    'head -n 50 a.ts | tail -n 10 | head -n 2',
    'head -n 50 a.ts | tail -n 10 b.ts',
    'head -n 50 a.ts | tail -n +10',
    'tail -n 50 a.ts | head -n 10',
    'head -n 50 a.ts | grep foo',
    'head -n 50 a.ts || tail -n 10',
    'cat a.ts | tail -n 10',
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

  it('resolves a path against the leading cd', async () => {
    expect(await traceBashRead(`cd ${cwd} && cat a.ts`, '/elsewhere')).toMatchObject({
      path: join(cwd, 'a.ts'),
    });
    expect(await traceBashRead(`cd ${cwd} && cat a.ts`, cwd)).toMatchObject({ path: 'a.ts', hash });
  });

  it('places a head | tail window inside the head', async () => {
    expect(await traceBashRead('head -n 60 a.ts | tail -n 20', cwd)).toMatchObject({
      offset: 41,
      limit: 20,
    });
    // A head past the end of the file is the end of the file.
    expect(await traceBashRead('head -n 500 a.ts | tail -n 20', cwd)).toMatchObject({
      offset: 81,
      limit: 20,
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'files a miscased path on a case-insensitive disk under the project key',
    async () => {
      const upper = cwd.replace(/reika-bashread-unit-/, 'REIKA-BASHREAD-UNIT-');
      expect(await traceBashRead(`cd ${upper} && cat a.ts`, cwd)).toMatchObject({ path: 'a.ts' });
    },
  );

  it('skips a file it cannot read', async () => {
    expect(await traceBashRead('cat missing.ts', cwd)).toBeUndefined();
  });
});
