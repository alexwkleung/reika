import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUserPath } from './_paths.js';

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
