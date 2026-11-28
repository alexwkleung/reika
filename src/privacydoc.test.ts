import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// docs/privacy.md promises it lists every file Reika keeps under ~/.config/reika. A new path added
// in code and not on the page would make that promise false without anyone noticing.

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_JOIN = /join\(homedir\(\), '\.config', 'reika', '([^']+)'/g;
// Read, never written: the user's own settings, instructions and skills.
const USER_AUTHORED = new Set(['.env', 'skills']);

describe('docs/privacy.md', () => {
  it('names every path the code keeps under ~/.config/reika', async () => {
    const listed = await exec('git', ['ls-files', '-z', 'src/*.ts', 'src/*.tsx'], {
      cwd: ROOT,
    }).catch(() => null);
    if (!listed) return;
    const files = listed.stdout.split('\0').filter(f => f && !/\.test\.tsx?$/.test(f));
    const names = new Set<string>();
    for (const f of files) {
      const text = await readFile(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(CONFIG_JOIN)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(5);
    const page = await readFile(join(ROOT, 'docs', 'privacy.md'), 'utf8');
    const missing = [...names].filter(n => !USER_AUTHORED.has(n) && !page.includes(`\`${n}`));
    expect(missing).toEqual([]);
  });
});
