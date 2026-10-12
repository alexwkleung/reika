import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  escapesProject,
  GIT_METADATA_WARNING,
  gitMetadataWarning,
  resolveUserPath,
} from './_paths.js';

describe('resolveUserPath', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(resolveUserPath('/some/cwd', '~')).toBe(homedir());
  });

  it('expands ~/ prefixes', () => {
    expect(resolveUserPath('/some/cwd', '~/Git/kana')).toBe(join(homedir(), 'Git', 'kana'));
  });

  it('resolves other paths against cwd', () => {
    expect(resolveUserPath('/some/cwd', 'packages/ui')).toBe('/some/cwd/packages/ui');
    expect(resolveUserPath('/some/cwd', '/abs/path')).toBe(resolve('/abs/path'));
  });

  it('does not expand ~user or mid-path tildes', () => {
    expect(resolveUserPath('/some/cwd', '~other/x')).toBe('/some/cwd/~other/x');
    expect(resolveUserPath('/some/cwd', 'a/~/b')).toBe('/some/cwd/a/~/b');
  });
});

describe('escapesProject', () => {
  it.each([
    ['the project root itself', '/repo'],
    ['a nested path', '/repo/src/tools/x.ts'],
    ['a path with an interior ..', '/repo/src/../lib/x.ts'],
  ])('is false for %s', (_label, full) => {
    expect(escapesProject('/repo', full)).toBe(false);
  });

  it.each([
    ['the parent directory', '/x.ts'],
    ['a sibling of the project', '/other/x.ts'],
    ['a prefix-sharing sibling', '/repo-backup/x.ts'],
    ['the home directory', join(homedir(), '.zshrc')],
  ])('is true for %s', (_label, full) => {
    expect(escapesProject('/repo', full)).toBe(true);
  });

  // The escape the model actually reaches for, end to end: resolveUserPath expands it deliberately,
  // so the two functions have to agree about what that produces.
  it('is true for a ~/ path the model supplied', () => {
    expect(escapesProject('/repo', resolveUserPath('/repo', '~/.zshrc'))).toBe(true);
  });
});

// A name beginning with two dots is an ordinary in-project file. `rel.startsWith('..')` read it as
// an escape, which under `bypass` refuses a legitimate write outright and with a wrong reason.
describe('escapesProject — two-dot names are not escapes', () => {
  it.each([['..config/x.ts'], ['..hidden'], ['src/..cache/y.ts']])('is false for %s', name => {
    expect(escapesProject('/repo', `/repo/${name}`)).toBe(false);
  });

  it('is still true for a real parent escape', () => {
    expect(escapesProject('/repo', '/repo/../x.ts')).toBe(true);
  });

  it('is still true for the bare parent', () => {
    expect(escapesProject('/repo', resolve('/repo', '..'))).toBe(true);
  });
});

// process.cwd() is symlink-resolved, so a project reached through a symlinked parent gives a cwd
// that no longer string-matches the path the model was told to use. Flagging that as an escape
// refuses a write INTO the project — under bypass, with no override.
describe('escapesProject — symlinked cwd', () => {
  let real: string;
  let link: string;

  beforeAll(async () => {
    real = await mkdtemp(join(tmpdir(), 'reika-real-'));
    link = join(await mkdtemp(join(tmpdir(), 'reika-link-')), 'proj');
    await symlink(real, link, 'dir');
  });
  afterAll(async () => {
    await rm(real, { recursive: true, force: true });
    await rm(join(link, '..'), { recursive: true, force: true });
  });

  it('does not flag a path reached through the symlink as outside', () => {
    // cwd is the resolved form (what process.cwd() returns); the model supplies the link form.
    expect(escapesProject(real, join(link, 'src/a.ts'))).toBe(false);
  });

  it('does not flag one for a file that does not exist yet', () => {
    expect(escapesProject(real, join(link, 'does/not/exist/yet.ts'))).toBe(false);
  });

  it('still flags a genuine escape reached through the symlink', () => {
    expect(escapesProject(real, join(link, '../elsewhere.ts'))).toBe(true);
  });

  it('leaves the documented symlink-out hole open, rather than quietly closing it', async () => {
    // A symlink INSIDE cwd pointing outward still reads as inside: the real-path retry only ever
    // acquits, never convicts. Pinned because the comment promises exactly this.
    const outside = await mkdtemp(join(tmpdir(), 'reika-out-'));
    const escape = join(real, 'escape');
    await symlink(outside, escape, 'dir');
    expect(escapesProject(real, join(escape, 'x.ts'))).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});

// #719: the sandbox profile's git-metadata denies, mirrored for the file tools. The name rules
// below are the profile's regex denies read as strings — an entry named `.git` anywhere in the
// path, the metadata files at its top level and under `modules/`/`worktrees/<x>/`, and the `hooks`
// subtree. cwd is a path that does not exist, so no git subprocess can run: a flagged path must be
// flagged by the names alone, and an unflagged one must not need the common-dir probe to pass.
describe('gitMetadataWarning — the names the sandbox refuses, at the file-tool level', () => {
  it.each([
    ['the git config', '.git/config'],
    ['config.worktree', '.git/config.worktree'],
    ['commondir', '.git/commondir'],
    ['the gitdir pointer', '.git/gitdir'],
    ['a hook', '.git/hooks/pre-commit'],
    ['the hooks dir itself', '.git/hooks'],
    ['a hook in a nested repo', 'sub/.git/hooks/post-commit'],
    ['a nested repo config', 'sub/.git/config'],
    ['a submodule config', '.git/modules/s/config'],
    ['a submodule hook', '.git/modules/s/hooks/post-commit'],
    ['a worktree commondir', '.git/worktrees/wt/commondir'],
    ['a worktree gitdir pointer', '.git/worktrees/wt/gitdir'],
    ['the .git pointer file itself', '.git'],
    ['a bare repo config under a *.git name', 'website.git/config'],
  ])('flags %s', (_label, rel) => {
    expect(gitMetadataWarning('/repo', `/repo/${rel}`)).toBe(GIT_METADATA_WARNING);
  });

  it.each([
    ['COMMIT_EDITMSG', '.git/COMMIT_EDITMSG'],
    ['HEAD', '.git/HEAD'],
    ['the index', '.git/index'],
    ['a branch named config', '.git/refs/heads/config'],
    ['a repo-relative name that only ends in .git', 'website.git/README'],
    ['a name that merely ends in .git', 'website.git'],
    ['.gitattributes', '.gitattributes'],
    ['a plain file named config', 'config'],
    ['a normal source file', 'src/a.ts'],
  ])('does not flag %s', (_label, rel) => {
    expect(gitMetadataWarning('/repo', `/repo/${rel}`)).toBeUndefined();
  });
});

// A git dir with no `.git` in its name escapes the name rules — `git init --bare`, a dotfiles
// repo, a `--separate-git-dir` target. The GITDIR group (the profile's `(subpath GITDIR/…)`
// denies, spelled against the session cwd's resolved common git dir) is what catches those.
describe('gitMetadataWarning — the GITDIR group for a git dir with no .git name', () => {
  let cwd: string;

  beforeEach(async () => {
    // The prefix carries regex-special characters on purpose: the GITDIR deny spells the common
    // dir into a regex, and an unescaped `.`/`+` in the cwd's own name must not widen the match.
    cwd = await mkdtemp(join(tmpdir(), 'reika+git.dir-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('flags config and hooks under the bare repo the cwd is in', () => {
    expect(gitMetadataWarning(cwd, join(cwd, 'config'))).toBe(GIT_METADATA_WARNING);
    expect(gitMetadataWarning(cwd, join(cwd, 'config.worktree'))).toBe(GIT_METADATA_WARNING);
    expect(gitMetadataWarning(cwd, join(cwd, 'hooks/pre-commit'))).toBe(GIT_METADATA_WARNING);
    expect(gitMetadataWarning(cwd, join(cwd, 'worktrees/wt/commondir'))).toBe(GIT_METADATA_WARNING);
    expect(gitMetadataWarning(cwd, join(cwd, 'modules/s/config'))).toBe(GIT_METADATA_WARNING);
  });

  it('leaves the rest of the bare repo alone', () => {
    expect(gitMetadataWarning(cwd, join(cwd, 'HEAD'))).toBeUndefined();
    expect(gitMetadataWarning(cwd, join(cwd, 'objects/ab/cdef'))).toBeUndefined();
    expect(gitMetadataWarning(cwd, join(cwd, 'COMMIT_EDITMSG'))).toBeUndefined();
  });

  it('does not let a regex-special character in the cwd name match a sibling', () => {
    // The `.` in `reika+git.dir-<suffix>` would match any character unescaped: a sibling dir that
    // differs exactly there must not read as this repo's metadata.
    const sibling = cwd.replace('git.dir', 'gitxdir');
    expect(gitMetadataWarning(sibling, join(sibling, 'config'))).toBeUndefined();
  });

  it('finds a repo created after an earlier probe of the same cwd', async () => {
    // A null answer is not cached: a `--separate-git-dir`/bare repo the user creates mid-session
    // must still reach the GITDIR group on the next write.
    const dir = await mkdtemp(join(tmpdir(), 'reika+git.late-'));
    try {
      expect(gitMetadataWarning(dir, join(dir, 'config'))).toBeUndefined();
      execFileSync('git', ['init', '-q', '--bare'], { cwd: dir });
      expect(gitMetadataWarning(dir, join(dir, 'config'))).toBe(GIT_METADATA_WARNING);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
