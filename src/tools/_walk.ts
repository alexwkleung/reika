import { relative, sep } from 'node:path';
import type { Ignore } from 'ignore';

export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);

export function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_DIRS.has(name);
}

// True when the path the model explicitly named is itself filtered out by the ignore rules —
// a gitignored dir (`release/`), a build dir (`dist/`), a dotfile dir, or anything outside cwd
// that .gitignore has no say over. Naming such a path is an explicit request to see inside it,
// usually to verify output the model just produced ("did the build write the dmg?"). Filtering
// there returns a silent zero, which a weak model reads as "the directory is empty" and then
// spends rounds hunting for output that was in front of it. So callers drop the filters for that
// one call. Also guards `ignore`, which throws on a `../`-relative or empty path.
export function isFilteredTarget(cwd: string, target: string, ig: Ignore | undefined): boolean {
  const rel = relative(cwd, target);
  if (rel === '') return false; // cwd itself: filters apply as normal
  if (rel.startsWith('..')) return true; // outside cwd — this repo's .gitignore doesn't apply
  if (rel.split(sep).some(shouldSkipDir)) return true;
  return ig?.ignores(rel + '/') ?? false;
}
