import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

// Resolve a model-supplied path against cwd. Models routinely emit `~/...`
// paths, which node's resolve() treats as a literal directory named "~".
export function resolveUserPath(cwd: string, path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

// Whether a resolved path lands outside the project. `relative` returns a `..`-prefixed path for an
// escape and an absolute one when the two share no root at all (another Windows drive).
//
// A string comparison, NOT containment: a symlink inside cwd pointing outward resolves within the
// project by this test and writes outside it in reality. That is the right trade for a confused
// model, which is what this guards against — it is not a defense against a determined one, and
// nothing should be built on top of it as though it were. Kernel-enforced confinement is #163.
export function escapesProject(cwd: string, full: string): boolean {
  const rel = relative(cwd, full);
  if (rel === '') return false;
  return rel.startsWith('..') || isAbsolute(rel);
}

// The approval warning for a write that lands outside the project, shared so `write` and `edit`
// raise the identical flag. `warnings` is what makes an approval bypass session-auto-approve
// (App.tsx hasWarnings), so this is the whole mechanism by which such a write reaches the user at
// all — under `safe` neither tool passed one, and every write auto-approved to any path.
//
// No path in the text: the modal prints the subject directly above it, and repeating it there only
// pushed the line past the dialog width and wrapped it.
export const OUTSIDE_PROJECT_WARNING = 'Writes outside the project directory';
