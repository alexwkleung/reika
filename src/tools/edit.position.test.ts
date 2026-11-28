import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { editTool, positionalEditTool, positionLands } from './edit.js';
import { readTool } from './read.js';
import { defaultTools, grindTools } from './index.js';
import { gutterLine, lineHash, parseLineRef } from './_lineref.js';

let cwd: string;
const saved = process.env.REIKA_EDIT_POSITION;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-editpos-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  if (saved === undefined) delete process.env.REIKA_EDIT_POSITION;
  else process.env.REIKA_EDIT_POSITION = saved;
});

const ctx = () => ({ cwd, ignore: ignore() });
const FILE = 'export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n';
const ref = (n: number, text: string) => `${n}:${lineHash(text)}`;

async function write(content = FILE): Promise<string> {
  const p = join(cwd, 'f.ts');
  await writeFile(p, content, 'utf8');
  return p;
}

describe('flag off', () => {
  it('registers the plain edit tool and an unhashed read gutter', async () => {
    delete process.env.REIKA_EDIT_POSITION;
    expect(defaultTools().find(t => t.name === 'edit')).toBe(editTool);
    expect(grindTools().find(t => t.name === 'edit')).toBe(editTool);
    await write();
    const r = await readTool.run({ path: 'f.ts' }, ctx());
    expect(r.payload?.split('\n')[0]).toBe('    1│export function a() {');
  });
});

describe('flag on', () => {
  beforeEach(() => {
    process.env.REIKA_EDIT_POSITION = '1';
  });

  it('registers the positional tool and hashes the read gutter', async () => {
    expect(defaultTools().find(t => t.name === 'edit')).toBe(positionalEditTool);
    expect(grindTools().find(t => t.name === 'edit')).toBe(positionalEditTool);
    await write();
    const r = await readTool.run({ path: 'f.ts' }, ctx());
    expect(r.payload?.split('\n')[0]).toBe(
      `    1:${lineHash('export function a() {')}│export function a() {`,
    );
  });
});

describe('positionalEditTool', () => {
  it('falls through to old_string matching when no position is given', async () => {
    const p = await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', old_string: 'return 1;', new_string: 'return 10;' },
      ctx(),
    );
    expect(r.summary).toMatch(/^Edited/);
    expect(await readFile(p, 'utf8')).toContain('return 10;');
  });

  it('refuses old_string together with a position', async () => {
    await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', old_string: 'return 1;', insert_after: 'a()', new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/not both/);
  });

  it('refuses two positions at once', async () => {
    await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', insert_after: 'a()', start_line: '1:abc', new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/give one position/);
  });

  it('inserts after an anchor line', async () => {
    const p = await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', insert_after: 'function b()', new_string: '  // b\n' },
      ctx(),
    );
    expect(r.summary).toBe('Edited f.ts at line 6 (+1 -0)');
    expect(await readFile(p, 'utf8')).toBe(FILE.replace('b() {\n', 'b() {\n  // b\n'));
    expect(r.diff?.text).toContain('+   // b');
  });

  it('inserts before an anchor line', async () => {
    const p = await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', insert_before: 'function b()', new_string: '// doc' },
      ctx(),
    );
    expect(r.summary).toMatch(/^Edited f.ts at line 5/);
    expect(await readFile(p, 'utf8')).toContain('\n// doc\nexport function b()');
  });

  it('inserts after the last line of a file with no trailing newline', async () => {
    const p = await write('a\nb');
    await positionalEditTool.run({ path: 'f.ts', insert_after: 'b', new_string: 'c' }, ctx());
    expect(await readFile(p, 'utf8')).toBe('a\nb\nc');
  });

  it('refuses an anchor on several lines and shows them hashed', async () => {
    const p = await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', insert_after: 'export function', new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/on 2 lines .*lines 1, 5/);
    expect(r.payload).toContain(gutterLine(5, 'export function b() {', true));
    expect(await readFile(p, 'utf8')).toBe(FILE);
  });

  it('refuses an anchor no line contains', async () => {
    await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', insert_after: 'function c()', new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/no line of f.ts contains "function c\(\)"/);
  });

  it('replaces a hash-checked range and returns the removed lines', async () => {
    const p = await write();
    const r = await positionalEditTool.run(
      {
        path: 'f.ts',
        start_line: ref(5, 'export function b() {'),
        end_line: ref(7, '}'),
        new_string: 'export const b = () => 2;\n',
      },
      ctx(),
    );
    expect(r.summary).toMatch(/^Edited f.ts at line 5/);
    expect(await readFile(p, 'utf8')).toBe(
      'export function a() {\n  return 1;\n}\n\nexport const b = () => 2;\n',
    );
    expect(r.payload).toContain('lines 5-7 of f.ts were replaced; they were:');
    expect(r.payload).toContain('    6│  return 2;');
  });

  it('accepts a single line with only start_line', async () => {
    const p = await write();
    await positionalEditTool.run(
      { path: 'f.ts', start_line: ref(2, '  return 1;'), new_string: '  return 11;' },
      ctx(),
    );
    expect(await readFile(p, 'utf8')).toContain('  return 11;\n}');
  });

  it('deletes a range without leaving a blank line', async () => {
    const p = await write();
    await positionalEditTool.run(
      { path: 'f.ts', start_line: ref(4, ''), end_line: ref(7, '}'), new_string: '' },
      ctx(),
    );
    expect(await readFile(p, 'utf8')).toBe('export function a() {\n  return 1;\n}\n');
  });

  it('refuses a stale hash, writes nothing, and points at where the lines moved', async () => {
    const p = await write('// header\n' + FILE);
    const r = await positionalEditTool.run(
      {
        path: 'f.ts',
        start_line: ref(5, 'export function b() {'),
        end_line: ref(7, '}'),
        new_string: 'x',
      },
      ctx(),
    );
    expect(r.summary).toMatch(/line 5 of f.ts is not the line you read/);
    expect(r.summary).toMatch(/appear to be at 6-8 now/);
    expect(r.payload).toContain(gutterLine(5, '', true));
    expect(await readFile(p, 'utf8')).toBe('// header\n' + FILE);
  });

  it('refuses a range without hashes and shows the current ones', async () => {
    await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', start_line: 2, end_line: 2, new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/need the hash/);
    expect(r.payload).toContain(gutterLine(2, '  return 1;', true));
  });

  it('refuses a range outside the file', async () => {
    await write();
    const r = await positionalEditTool.run(
      { path: 'f.ts', start_line: '9:abc', end_line: '12:abc', new_string: 'x' },
      ctx(),
    );
    expect(r.summary).toMatch(/not a range in f.ts, which has 7 lines/);
  });

  it('asks approval with the real diff', async () => {
    await write();
    const previews: string[] = [];
    await positionalEditTool.run(
      { path: 'f.ts', insert_after: 'function a()', new_string: '  // a' },
      {
        ...ctx(),
        requestApproval: async req => {
          previews.push(req.preview ?? '');
          return false;
        },
      },
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain('  export function a() {\n+   // a');
  });
});

describe('positionLands', () => {
  it('is true for a unique anchor or a matching range, false otherwise', () => {
    expect(positionLands(FILE, { insert_after: 'function a', new_string: 'x' })).toBe(true);
    expect(positionLands(FILE, { insert_after: 'export', new_string: 'x' })).toBe(false);
    expect(positionLands(FILE, { start_line: ref(2, '  return 1;'), new_string: 'x' })).toBe(true);
    expect(positionLands(FILE, { start_line: '2:000', new_string: 'x' })).toBe(false);
  });
});

describe('parseLineRef', () => {
  it('reads the gutter forms', () => {
    expect(parseLineRef('120:A3F')).toEqual({ line: 120, hash: 'a3f' });
    expect(parseLineRef(' 120:a3f│  return x;')).toEqual({ line: 120, hash: 'a3f' });
    expect(parseLineRef('120')).toEqual({ line: 120 });
    expect(parseLineRef(120)).toEqual({ line: 120 });
    expect(parseLineRef('line 120')).toBeNull();
  });
});
