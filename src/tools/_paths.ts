import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Resolve a model-supplied path against cwd. Models routinely emit `~/...`
// paths, which node's resolve() treats as a literal directory named "~".
export function resolveUserPath(cwd: string, path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

// Pure string form of the test. `relative` returns a `..`-prefixed path for an escape and an
// absolute one when the two share no root at all (another Windows drive).
//
// The `..` check is on a whole segment, not a prefix: `relative('/repo', '/repo/..config/x')` is
// `'..config/x'`, which a bare startsWith('..') reads as an escape and would refuse a legitimate
// in-project file whose name begins with two dots.
function escapesByString(cwd: string, full: string): boolean {
  const rel = relative(cwd, full);
  if (rel === '') return false;
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

// Realpath the nearest existing ancestor and re-append the tail. A write target usually does not
// exist yet, so realpath on the whole path would just throw; the parent almost always does.
function realResolve(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(head), ...[...tail].reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return p; // reached the root without finding anything real
      tail.push(basename(head));
      head = parent;
    }
  }
}

// Whether a resolved path lands outside the project.
//
// A string comparison first, and a symlink-resolved one only to ACQUIT. That asymmetry is the
// point: `process.cwd()` is already symlink-resolved, so on macOS a project reached through
// `/tmp` (a symlink to `/private/tmp`) has `cwd = /private/tmp/proj`, and a model-supplied
// `/tmp/proj/x.ts` reads as an escape by string alone — under `bypass` that is a hard refusal of
// a write into the project itself. Re-testing through real paths clears it.
//
// It never runs the other way: a path the string test already calls inside is returned as inside
// without touching the filesystem. So a symlink INSIDE cwd pointing outward still passes, exactly
// as before — that is the right trade for a confused model, which is what this guards against. It
// is not a defense against a determined one, and nothing should be built on top of it as though it
// were. Kernel-enforced confinement is #163.
export function escapesProject(cwd: string, full: string): boolean {
  if (!escapesByString(cwd, full)) return false;
  return escapesByString(realResolve(cwd), realResolve(full));
}

// The approval warning for a write that lands outside the project, shared so `write` and `edit`
// raise the identical flag. `warnings` is what makes an approval bypass session-auto-approve
// (App.tsx hasWarnings), so this is the whole mechanism by which such a write reaches the user at
// all — under `safe` neither tool passed one, and every write auto-approved to any path.
//
// No path in the text: the modal prints the subject directly above it, and repeating it there only
// pushed the line past the dialog width and wrapped it.
export const OUTSIDE_PROJECT_WARNING = 'Writes outside the project directory';
