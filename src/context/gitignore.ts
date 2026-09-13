import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { shouldSkipDir } from '../tools/_walk.js';

// One matcher for the whole tree, so list/glob/grep and the file index all agree on what is
// hidden. Git scopes a nested .gitignore to its own directory; `ignore` only knows root-relative
// paths, so nested files are folded in with their patterns re-rooted (see scopePattern). Parents
// are added before children, which is also git's precedence: a child's `!keep` can re-include
// what the root ignored.
export async function loadGitignore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  for (const path of [join(cwd, '.gitignore'), join(cwd, '.git', 'info', 'exclude')]) {
    try {
      ig.add(await readFile(path, 'utf8'));
    } catch {
      // missing file is fine
    }
  }
  await addNested(cwd, '', ig, 0, { files: 0 });
  return ig;
}

// Bounded so a huge or pathological tree can't turn bootstrap into a full crawl: the file index
// stops at 10k files and this stops well before that matters.
const MAX_NESTED_DEPTH = 8;
const MAX_NESTED_FILES = 200;

// Shared across the whole recursion: the file cap is tree-wide, depth is per branch.
type Budget = { files: number };

async function addNested(
  cwd: string,
  rel: string,
  ig: Ignore,
  depth: number,
  b: Budget,
): Promise<void> {
  if (depth >= MAX_NESTED_DEPTH) return;
  let entries;
  try {
    entries = await readdir(join(cwd, rel), { withFileTypes: true });
  } catch {
    return;
  }
  // Directory listings are not ordered; sort so the matcher is built the same way every run.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    const sub = rel ? `${rel}/${entry.name}` : entry.name;
    // Rules accumulated so far decide whether to look inside — an ignored dir's own .gitignore
    // can't re-include anything (git doesn't read it either).
    if (ig.ignores(sub + '/')) continue;
    try {
      const text = await readFile(join(cwd, sub, '.gitignore'), 'utf8');
      if (++b.files > MAX_NESTED_FILES) return;
      ig.add(scopeGitignore(sub, text));
    } catch {
      // no nested file here
    }
    await addNested(cwd, sub, ig, depth + 1, b);
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
