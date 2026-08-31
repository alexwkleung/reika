import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escapesProject, resolveUserPath } from './_paths.js';

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
