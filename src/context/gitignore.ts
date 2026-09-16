import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { shouldSkipDir } from '../tools/_walk.js';

// One matcher for the whole tree, so list/glob/grep and the file index all agree on what is
// hidden. Git scopes a nested .gitignore to its own directory; `ignore` only knows root-relative
// paths, so nested files are folded in with their patterns re-rooted (see scopePattern). Parents
// are added before children, which is also git's precedence: a child's `!keep` can re-include
// what the root ignored.
export async function loadGitignore(
  cwd: string,
  limits: NestedLimits = DEFAULT_NESTED_LIMITS,
): Promise<Ignore> {
  const ig = ignore();
  for (const path of [join(cwd, '.gitignore'), join(cwd, '.git', 'info', 'exclude')]) {
    try {
      ig.add(await readFile(path, 'utf8'));
    } catch {
      // missing file is fine
    }
  }
  await addNested(cwd, ig, limits);
  return ig;
}

// Bounded so a huge or pathological tree can't turn bootstrap into a full crawl. The depth and
// file caps alone were not enough: a home directory has ~19k directories within 8 levels and
// almost no nested .gitignore files, so the walk ran 9s to find nothing (#362). The directory
// cap is what bounds the time; the walk is breadth-first so it spends that budget on the
// shallow `packages/x/.gitignore` shape nested files actually take, not on one deep subtree.
export type NestedLimits = { depth: number; files: number; dirs: number };
export const DEFAULT_NESTED_LIMITS: NestedLimits = { depth: 8, files: 200, dirs: 2000 };

async function addNested(cwd: string, ig: Ignore, limits: NestedLimits): Promise<void> {
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let dirs = 0;
  let files = 0;
  for (let i = 0; i < queue.length; i++) {
    const { rel, depth } = queue[i];
    if (++dirs > limits.dirs) return;
    let entries;
    try {
      entries = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    // Directory listings are not ordered; sort so the matcher is built the same way every run.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // The root's own file was read by the caller. The listing already says whether a nested one
    // exists, so no readFile is attempted (and no ENOENT thrown) in the many directories without.
    if (rel !== '' && entries.some(e => e.name === '.gitignore' && e.isFile())) {
      try {
        const text = await readFile(join(cwd, rel, '.gitignore'), 'utf8');
        if (++files > limits.files) return;
        ig.add(scopeGitignore(rel, text));
      } catch {
        // vanished between listing and read
      }
    }
    if (depth + 1 >= limits.depth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      // Rules accumulated so far decide whether to look inside — an ignored dir's own .gitignore
      // can't re-include anything (git doesn't read it either). Every ancestor's file has been
      // folded in by now: breadth-first visits a directory only after all shallower ones.
      if (ig.ignores(sub + '/')) continue;
      queue.push({ rel: sub, depth: depth + 1 });
    }
  }
}

// Re-root every pattern of a nested .gitignore at `dir` so it means the same thing against
// root-relative paths. Exported for tests.
export function scopeGitignore(dir: string, text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const scoped = scopePattern(dir, line);
    if (scoped) out.push(scoped);
  }
  return out;
}

function scopePattern(dir: string, line: string): string | undefined {
  let neg = '';
  let pat = line;
  if (pat.startsWith('!')) {
    neg = '!';
    pat = pat.slice(1);
  }
  // Trailing spaces are insignificant unless escaped — same rule git applies.
  pat = pat.replace(/(?<!\\) +$/, '');
  if (pat === '') return undefined;
  // Git: a slash anywhere but the end anchors the pattern to the .gitignore's directory;
  // otherwise it matches at any depth below it.
  const anchored = pat.slice(0, -1).includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  else if (!anchored) pat = `**/${pat}`;
  return `${neg}${dir}/${pat}`;
}
