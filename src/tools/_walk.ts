export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);

export function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return SKIP_DIRS.has(name);
}
