import { fdir } from 'fdir';
import type { Ignore } from 'ignore';
import { relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
const MAX_FILES = 10_000;

export async function buildFileIndex(cwd: string, ig: Ignore): Promise<string[]> {
  const crawler = new fdir()
    .withRelativePaths()
    .exclude((dirName, dirPath) => {
      // .reika/ is our own scratch dir (skills, handoff docs, etc.) — keep it
      // visible to `@` autocomplete and tool walks. Other dot-dirs stay hidden.
      if (dirName === '.reika') return false;
      if (dirName.startsWith('.') || SKIP_DIRS.has(dirName)) return true;
      const rel = relative(cwd, dirPath);
      return rel.length > 0 && ig.ignores(rel + '/');
    })
    .filter(relPath => !ig.ignores(relPath))
    .crawl(cwd);
  const files = (await crawler.withPromise()) as string[];
  files.sort();
  return files.slice(0, MAX_FILES);
}

// Would `buildFileIndex` have included this relative path? Mirrors the crawl's
// directory and gitignore filtering so an incrementally-added entry obeys the
// same contract as the startup scan (no node_modules/, dist/, dot-dirs, or
// gitignored paths leaking into `@` autocomplete).
function indexable(relPath: string, ig: Ignore): boolean {
  const segs = relPath.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    const d = segs[i];
    if (d === '.reika') continue;
    if (d.startsWith('.') || SKIP_DIRS.has(d)) return false;
  }
  return !ig.ignores(relPath);
}

// Splice a newly-written path into a sorted file index, keeping it sorted and
// deduped. Returns the SAME array reference when nothing changes (already
// present, filtered out, or at the cap) so callers can skip a state update.
// Lets `@` autocomplete pick up files the model creates mid-session without a
// full re-crawl. See ui/App.tsx onMessage.
export function addFileToIndex(index: string[], relPath: string, ig: Ignore): string[] {
  if (index.length >= MAX_FILES || !indexable(relPath, ig)) return index;
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid] < relPath) lo = mid + 1;
    else hi = mid;
  }
  if (index[lo] === relPath) return index;
  const next = index.slice();
  next.splice(lo, 0, relPath);
  return next;
}
