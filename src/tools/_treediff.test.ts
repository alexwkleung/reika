import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EDIT_LENGTH } from './_diff.js';
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
  it('falls back to the files the command names when there is no repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'treediff-plain-'));
    try {
      await writeFile(join(plain, 'a.txt'), 'one\n');
      const snap = (await snapshotTree(plain, "echo two >> a.txt && sed -i '' s/x/y/ b.txt"))!;
      expect(snap.root).toBeNull();
      expect([...snap.before.keys()].map(p => p.slice(p.lastIndexOf('/') + 1)).sort()).toEqual([
        'a.txt',
        'b.txt',
      ]);
      expect(snap.before.get(join(await realpath(plain), 'b.txt'))).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('keeps the previous bytes only of files git already reports dirty', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    await write('new.txt', 'untracked\n');
    const snap = await snapshotTree(dir, 'echo');
    expect(snap).not.toBeNull();
    expect([...snap!.before.keys()].sort()).toEqual(['new.txt', 'sub/b.ts']);
    expect(snap!.before.get('sub/b.ts')).toEqual({ text: 'keep\ndirty\n', binary: false });
  });
});

describe('changesSince', () => {
  it('reports nothing when the command touched no file', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    expect(await changesSince(snap)).toBeNull();
  });

  it('diffs a clean tracked file against HEAD, one hunk per edited region', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
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
    const snap = (await snapshotTree(dir, 'echo'))!;
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
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('sub/b.ts', 'keep\ndirty\nmore\n');
    const [f] = (await changesSince(snap))!.files;
    // `dirty` was there before the command: context, not an addition.
    expect(f.hunks[0].text).toBe('  keep\n  dirty\n+ more');
    expect(f.added).toBe(1);
  });

  it('shows a created file as all additions and a removed one as all removals', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
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
    const snap = (await snapshotTree(dir, 'echo'))!;
    sh('git', ['commit', '-qam', 'save']);
    expect(await changesSince(snap)).toBeNull();
  });

  it('reports a reverted file: the bytes changed even though git now calls it clean', async () => {
    await write('sub/b.ts', 'keep\ndirty\n');
    const snap = (await snapshotTree(dir, 'echo'))!;
    sh('git', ['checkout', '--', 'sub/b.ts']);
    const [f] = (await changesSince(snap))!.files;
    expect(f.hunks[0].text).toBe('  keep\n- dirty');
  });

  // HEAD moves (#337): a checkout, merge, reset, or an edit committed in the same call leaves the
  // tree clean against the new head, so status lists nothing and the diff has to come from the
  // two commits.
  describe('when the command moved HEAD', () => {
    const branchWith = (name: string, edits: () => Promise<void>): Promise<void> =>
      (async () => {
        sh('git', ['checkout', '-qb', name]);
        await edits();
        sh('git', ['add', '-A']);
        sh('git', ['commit', '-qm', name]);
        sh('git', ['checkout', '-q', 'main']);
      })();

    beforeEach(() => {
      sh('git', ['branch', '-qM', 'main']);
    });

    it('a checkout diffs each file against the commit HEAD was on', async () => {
      await branchWith('feature', async () => {
        await write('a.ts', numbered(20).replace('line 2\n', 'LINE 2\n'));
        await write('c.txt', 'new on branch\n');
        await rm(join(dir, 'sub/b.ts'));
      });
      const snap = (await snapshotTree(dir, 'git checkout feature'))!;
      sh('git', ['checkout', '-q', 'feature']);
      const { files, more } = (await changesSince(snap))!;
      expect(more).toBe(0);
      expect(files.map(f => [f.path, f.kind, f.added, f.removed])).toEqual([
        ['a.ts', 'modified', 1, 1],
        ['c.txt', 'created', 1, 0],
        ['sub/b.ts', 'deleted', 0, 1],
      ]);
      expect(files[0].hunks[0].text).toContain('- line 2\n+ LINE 2');
    });

    it('an edit committed in the same call still shows', async () => {
      const snap = (await snapshotTree(dir, "sed -i '' s/x/y/ a.ts && git commit -qam edit"))!;
      await write('a.ts', numbered(20).replace('line 5\n', 'LINE 5\n'));
      sh('git', ['commit', '-qam', 'edit']);
      const [f] = (await changesSince(snap))!.files;
      expect(f.path).toBe('a.ts');
      expect(f.hunks[0].text).toContain('- line 5\n+ LINE 5');
    });

    it('a merge shows what it brought in, and a reset shows what it took away', async () => {
      await branchWith('feature', () => write('c.txt', 'merged\n'));
      const merged = (await snapshotTree(dir, 'git merge feature'))!;
      sh('git', ['merge', '-q', 'feature']);
      const { files } = (await changesSince(merged))!;
      expect(files.map(f => [f.path, f.kind])).toEqual([['c.txt', 'created']]);
      expect(files[0].hunks[0].text).toBe('+ merged');

      const reset = (await snapshotTree(dir, 'git reset --hard HEAD~1'))!;
      sh('git', ['reset', '-q', '--hard', 'HEAD~1']);
      const undone = (await changesSince(reset))!.files;
      expect(undone.map(f => [f.path, f.kind])).toEqual([['c.txt', 'deleted']]);
      expect(undone[0].hunks[0].text).toBe('- merged');
    });

    it('a dirty file the checkout carried over unchanged is not reported', async () => {
      await branchWith('feature', () => write('c.txt', 'new on branch\n'));
      await write('sub/b.ts', 'keep\ndirty\n');
      await write('untracked.txt', 'mine\n');
      const snap = (await snapshotTree(dir, 'git checkout feature'))!;
      sh('git', ['checkout', '-q', 'feature']);
      const { files } = (await changesSince(snap))!;
      expect(files.map(f => f.path)).toEqual(['c.txt']);
    });

    it('a commit that only saves an existing edit still shows nothing', async () => {
      await write('sub/b.ts', 'keep\ndirty\n');
      const snap = (await snapshotTree(dir, 'git commit -am save'))!;
      sh('git', ['commit', '-qam', 'save']);
      expect(await changesSince(snap)).toBeNull();
    });

    it('counts the files a large switch touched without drawing them all', async () => {
      await branchWith('wide', async () => {
        for (let i = 0; i < 11; i++) await write(`f${String(i).padStart(2, '0')}.txt`, 'x\n');
      });
      const snap = (await snapshotTree(dir, 'git checkout wide'))!;
      sh('git', ['checkout', '-q', 'wide']);
      const changes = (await changesSince(snap))!;
      expect(changes.files).toHaveLength(8);
      expect(changes.more).toBe(3);
    });
  });

  it('names a binary file without drawing its bytes', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80]));
    const [f] = (await changesSince(snap))!.files;
    expect(f.kind).toBe('binary');
    expect(f.hunks).toEqual([]);
  });

  it('paths are relative to the session cwd, reaching up with ../ when the edit was elsewhere', async () => {
    const cwd = join(dir, 'sub');
    const snap = (await snapshotTree(cwd, 'echo'))!;
    await write('a.ts', 'rewritten\n');
    await write('sub/b.ts', 'keep\nmore\n');
    const { files } = (await changesSince(snap))!;
    expect(files.map(f => f.path)).toEqual(['../a.ts', 'b.ts']);
  });

  it('leaves ignored files out, the same rule the file index applies', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('ignored.log', 'noise\n');
    expect(await changesSince(snap)).toBeNull();
  });

  it('caps the files it draws and counts the rest', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    for (let i = 0; i < 11; i++) await write(`f${String(i).padStart(2, '0')}.txt`, 'x\n');
    const changes = (await changesSince(snap))!;
    expect(changes.files).toHaveLength(8);
    expect(changes.more).toBe(3);
    expect(changes.files[0].path).toBe('f00.txt');
  });

  it('without a repo, diffs only the named files: an edit shows, a formatter sweep does not', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'treediff-plain-'));
    try {
      await writeFile(join(plain, 'a.txt'), 'one\n');
      await writeFile(join(plain, 'other.txt'), 'x\n');
      const snap = (await snapshotTree(plain, 'echo two >> a.txt; echo new > c.txt'))!;
      await writeFile(join(plain, 'a.txt'), 'one\ntwo\n');
      await writeFile(join(plain, 'c.txt'), 'new\n');
      await writeFile(join(plain, 'other.txt'), 'changed but unnamed\n');
      const { files, more } = (await changesSince(snap))!;
      expect(files.map(f => [f.path, f.kind])).toEqual([
        ['a.txt', 'modified'],
        ['c.txt', 'created'],
      ]);
      expect(files[0].hunks[0].text).toBe('  one\n+ two');
      expect(more).toBe(0);
      const swept = (await snapshotTree(plain, 'prettier --write .'))!;
      await writeFile(join(plain, 'a.txt'), 'formatted\n');
      expect(await changesSince(swept)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('caps the rows per file and counts the omitted ones, keeping the stats exact', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('big.txt', numbered(200));
    const [f] = (await changesSince(snap))!.files;
    expect(f.added).toBe(200);
    expect(f.hunks[0].text.split('\n')).toHaveLength(80);
    expect(f.omitted).toBe(120);
  });

  // A file that shares almost nothing with its previous bytes (a formatter reflow, a generated
  // file regenerated, `sed` over every line) is where Myers goes quadratic: seconds per file, on
  // the TUI thread, after a bash command (#244). It is named as a rewrite with its sizes instead.
  it('names a file rewritten past the edit cap, with both sizes, instead of diffing it', async () => {
    const n = MAX_EDIT_LENGTH * 3;
    await write('gen.txt', numbered(n));
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-qm', 'gen']);
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write(
      'gen.txt',
      Array.from({ length: n + 5 }, (_, i) => `row ${i + 1}`).join('\n') + '\n',
    );
    const t = performance.now();
    const [f] = (await changesSince(snap))!.files;
    expect(performance.now() - t).toBeLessThan(1000);
    expect(f.kind).toBe('rewritten');
    expect(f.hunks).toEqual([]);
    expect(f.removed).toBe(n);
    expect(f.added).toBe(n + 5);
    expect(f.omitted).toBeUndefined();
  });

  it('still diffs a large file whose change is small, exactly', async () => {
    const n = MAX_EDIT_LENGTH * 3;
    await write('gen.txt', numbered(n));
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-qm', 'gen']);
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('gen.txt', numbered(n).replace('line 2000\n', 'line two thousand\n'));
    const [f] = (await changesSince(snap))!.files;
    expect(f.kind).toBe('modified');
    expect([f.removed, f.added]).toEqual([1, 1]);
    expect(f.hunks[0].startLine).toBe(1997);
  });

  it('a created or deleted file past the cap is still drawn whole: nothing to pair', async () => {
    const n = MAX_EDIT_LENGTH * 3;
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('c.txt', numbered(n));
    await rm(join(dir, 'a.ts'));
    const { files } = (await changesSince(snap))!;
    expect(files.map(f => [f.path, f.kind, f.added, f.removed, f.omitted])).toEqual([
      ['a.ts', 'deleted', 0, 20, undefined],
      ['c.txt', 'created', n, 0, n - 80],
    ]);
    expect(files[1].hunks[0].text.split('\n')).toHaveLength(80);
    expect(files[1].hunks[0].text.startsWith('+ line 1\n+ line 2\n')).toBe(true);
  });

  it('an empty created file has no rows and no count', async () => {
    const snap = (await snapshotTree(dir, 'echo'))!;
    await write('empty.txt', '');
    const [f] = (await changesSince(snap))!.files;
    expect([f.kind, f.added, f.hunks]).toEqual(['created', 0, []]);
  });
});
