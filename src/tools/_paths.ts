import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Resolve a model-supplied path against cwd. Models routinely emit `~/...`
// paths, which node's resolve() treats as a literal directory named "~".
export function resolveUserPath(cwd: string, path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}
