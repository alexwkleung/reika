import { fdir } from 'fdir';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
const MAX_FILES = 10_000;

export async function buildFileIndex(cwd: string): Promise<string[]> {
  const crawler = new fdir()
    .withRelativePaths()
    .exclude(dirName => dirName.startsWith('.') || SKIP_DIRS.has(dirName))
    .crawl(cwd);
  const files = (await crawler.withPromise()) as string[];
  files.sort();
  return files.slice(0, MAX_FILES);
}
