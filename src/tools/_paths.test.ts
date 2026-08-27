import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
