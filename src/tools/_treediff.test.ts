import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesSince, snapshotTree } from './_treediff.js';

// Real git, real files: the module's whole job is reading git's view of the tree, and a mocked
// `git status` would only test the mock. Each test gets a fresh repo with one commit.
let dir: string;
const sh = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
};
const write = (rel: string, content: string): Promise<void> =>
  writeFile(join(dir, rel), content, 'utf8');
const numbered = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'treediff-'));
  sh('git', ['init', '-q']);
  sh('git', ['config', 'user.email', 'dev@example.com']);
  sh('git', ['config', 'user.name', 'dev']);
  await write('a.ts', numbered(20));
  await mkdir(join(dir, 'sub'));
  await write('sub/b.ts', 'keep\n');
  await write('.gitignore', 'ignored.log\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('snapshotTree', () => {
  it('is null outside a git repo, so bash shows no diff rather than guessing', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'treediff-plain-'));
    try {
      expect(await snapshotTree(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('keeps the previous bytes only of files git already reports dirty', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    await write('new.txt', 'untracked\n');
    const snap = await snapshotTree(dir);
    expect(snap).not.toBeNull();
    expect([...snap!.before.keys()].sort()).toEqual(['new.txt', 'sub/b.ts']);
    expect(snap!.before.get('sub/b.ts')).toEqual({ text: 'keep\ndirty\n', binary: false });
  });
});

describe('changesSince', () => {
  it('reports nothing when the command touched no file', async () => {
    const snap = (await snapshotTree(dir))!;
    expect(await changesSince(snap)).toBeNull();
  });

  it('diffs a clean tracked file against HEAD, one hunk per edited region', async () => {
    const snap = (await snapshotTree(dir))!;
    await write(
      'a.ts',
      numbered(20).replace('line 2\n', 'LINE 2\n').replace('line 18\n', 'LINE 18\n'),
    );
    const changes = (await changesSince(snap))!;
    expect(changes.more).toBe(0);
    expect(changes.files).toHaveLength(1);
    const [f] = changes.files;
    expect(f.path).toBe('a.ts');
    expect(f.kind).toBe('modified');
    expect(f.added).toBe(2);
    expect(f.removed).toBe(2);
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0].text).toBe('  line 1\n- line 2\n+ LINE 2\n  line 3\n  line 4\n  line 5');
    expect(f.hunks[0].startLine).toBe(1);
    expect(f.hunks[1].startLine).toBe(15);
    expect(f.hunks[1].text).toContain('- line 18\n+ LINE 18');
  });

  it('numbers a later hunk by both files once an earlier hunk changed the line count', async () => {
    const snap = (await snapshotTree(dir))!;
    await write(
      'a.ts',
      numbered(20).replace('line 2\n', 'line 2\nadded\nadded\n').replace('line 18\n', 'LINE 18\n'),
    );
    const [f] = (await changesSince(snap))!.files;
    expect(f.hunks[1].oldStartLine).toBe(15);
    expect(f.hunks[1].startLine).toBe(17);
  });

  it('diffs an already-dirty file against the snapshot, not HEAD', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    const snap = (await snapshotTree(dir))!;
    await write('sub/b.ts', 'keep\ndirty\nmore\n');
    const [f] = (await changesSince(snap))!.files;
    // `dirty` was there before the command: context, not an addition.
    expect(f.hunks[0].text).toBe('  keep\n  dirty\n+ more');
    expect(f.added).toBe(1);
  });

  it('shows a created file as all additions and a removed one as all removals', async () => {
    const snap = (await snapshotTree(dir))!;
    await write('c.txt', 'new\n');
    await rm(join(dir, 'sub/b.ts'));
    const { files } = (await changesSince(snap))!;
    expect(files.map(f => [f.path, f.kind])).toEqual([
      ['c.txt', 'created'],
      ['sub/b.ts', 'deleted'],
    ]);
    expect(files[0].hunks[0].text).toBe('+ new');
    expect(files[0].added).toBe(1);
    expect(files[1].hunks[0].text).toBe('- keep');
    expect(files[1].removed).toBe(1);
  });

  it('reports no change when a command only commits what was already dirty', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    const snap = (await snapshotTree(dir))!;
    sh('git', ['commit', '-qam', 'save']);
    expect(await changesSince(snap)).toBeNull();
  });

  it('reports a reverted file: the bytes changed even though git now calls it clean', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    const snap = (await snapshotTree(dir))!;
    sh('git', ['checkout', '--', 'sub/b.ts']);
    const [f] = (await changesSince(snap))!.files;
    expect(f.hunks[0].text).toBe('  keep\n- dirty');
  });

  it('names a binary file without drawing its bytes', async () => {
    const snap = (await snapshotTree(dir))!;
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80]));
    const [f] = (await changesSince(snap))!.files;
    expect(f.kind).toBe('binary');
    expect(f.hunks).toEqual([]);
  });

  it('paths are relative to the session cwd, reaching up with ../ when the edit was elsewhere', async () => {
    const cwd = join(dir, 'sub');
    const snap = (await snapshotTree(cwd))!;
    await write('a.ts', 'rewritten\n');
    await write('sub/b.ts', 'keep\nmore\n');
    const { files } = (await changesSince(snap))!;
    expect(files.map(f => f.path)).toEqual(['../a.ts', 'b.ts']);
  });

  it('leaves ignored files out, the same rule the file index applies', async () => {
    const snap = (await snapshotTree(dir))!;
    await write('ignored.log', 'noise\n');
    expect(await changesSince(snap)).toBeNull();
  });

  it('caps the files it draws and counts the rest', async () => {
    const snap = (await snapshotTree(dir))!;
    for (let i = 0; i < 11; i++) await write(`f${String(i).padStart(2, '0')}.txt`, 'x\n');
    const changes = (await changesSince(snap))!;
    expect(changes.files).toHaveLength(8);
    expect(changes.more).toBe(3);
    expect(changes.files[0].path).toBe('f00.txt');
  });

  it('caps the rows per file and counts the omitted ones, keeping the stats exact', async () => {
    const snap = (await snapshotTree(dir))!;
    await write('big.txt', numbered(200));
    const [f] = (await changesSince(snap))!.files;
    expect(f.added).toBe(200);
    expect(f.hunks[0].text.split('\n')).toHaveLength(80);
    expect(f.omitted).toBe(120);
  });
});
