import { fdir } from 'fdir';
import type { Ignore } from 'ignore';
import { relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
const MAX_FILES = 10_000;

export async function buildFileIndex(cwd: string, ig: Ignore): Promise<string[]> {
  const crawler = new fdir()
    .withRelativePaths()
    .exclude((dirName, dirPath) => {
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
