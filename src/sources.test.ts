import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// A source file with a raw NUL byte in it is INVISIBLE to `grep -r`: grep classifies the file as
// binary and skips it silently, so a repo-wide search for a symbol defined there returns the import
// sites and never the definition. check/typecheck.ts spent its life that way — its diagnostic key
// used two literal NULs as separators rather than the `\0` escape, and `grep -rn detectTsProject
// src` could not find the function it exports.
//
// The escape is the fix, and this is what keeps it fixed. Silent invisibility is the worst shape a
// tooling bug can take (the same reason an unservable tool call is made loud rather than returning
// "0 matches"), and nothing else in the repo would notice a recurrence: it compiles, it lints, it
// passes its own tests.

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('source hygiene', () => {
  it('has no raw NUL bytes in tracked text sources — they make a file invisible to grep', async () => {
    // Tracked files only, and only the ones meant to be text. Fails open outside a git checkout
    // (a tarball install), where there is no file list to check and nothing to protect.
    const listed = await exec(
      'git',
      ['ls-files', '-z', '*.ts', '*.tsx', '*.js', '*.json', '*.md'],
      {
        cwd: ROOT,
        maxBuffer: 8 * 1024 * 1024,
      },
    ).catch(() => null);
    if (!listed) return;
    const files = listed.stdout.split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    await Promise.all(
      files.map(async f => {
        const buf = await readFile(join(ROOT, f)).catch(() => null);
        if (buf?.includes(0)) offenders.push(f);
      }),
    );
    // Named, not counted: the whole point is that the file is hard to find by searching.
    expect(offenders).toEqual([]);
  });
});
