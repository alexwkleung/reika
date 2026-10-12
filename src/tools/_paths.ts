import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

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

// The approval warning for a write that lands in git's metadata. Same shape and mechanism as
// `OUTSIDE_PROJECT_WARNING`: under `safe` the warning pierces auto-approve and the user sees a
// modal; under `bypass` (no `requestApproval`) the write is refused outright. The sandbox half of
// this class refuses the same paths for every sandboxed command (#706); here a deliberately
// approved write is allowed, exactly as a user-approved bash command runs unsandboxed — the "user
// asks the agent to repair a hook" case the sandbox's hard deny would otherwise force into bash.
export const GIT_METADATA_WARNING =
  'Writes to git config or hooks (runs code at your next git command)';

// The names the sandbox profile refuses (src/tools/_sandbox.ts): any entry named `.git`, the
// metadata files at its top level and under `modules/`/`worktrees/<x>/`, and the `hooks` subtree.
// Unanchored, so a repo nested anywhere in the project is covered. Paths are normalized to `/` so
// a Windows separator cannot dodge the `/`-spelled rules. Case-insensitive because macOS's default
// volume is: `.git/Config` and `.GIT/hooks/x` write the real files, and on a case-sensitive volume
// the extra matches are only a prompt.
const GIT_METADATA_NAME_RE =
  /\/\.git$|\.git\/((modules\/.+\/|worktrees\/[^/]+\/)?(config|config\.worktree|commondir|gitdir))$|\.git\/(modules\/.+\/)?hooks(\/|$)/i;

// A common git dir NOT named `.git` (`git init --separate-git-dir`, a dotfiles bare repo) escapes
// the name rules, the same hole the sandbox's GITDIR param exists for. Protected places are the
// profile's `GITDIR` deny lines, written against the resolved common dir of the session cwd. This
// is the cwd's repo only — a git dir a target's OWN tree would resolve to is a separate repo whose
// paths the name rules still cover when it is a plain `.git` entry. The path is regex-escaped: a
// cwd may itself contain `.`, `+` or `(` (a dotted project name), and an unescaped one would match
// broader than the git dir.
const GIT_DIR_DENY_RE = (g: string): RegExp => {
  const dir = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${dir}$|^${dir}/(config|config\\.worktree|commondir|gitdir)$|^${dir}/hooks(/|$)|^${dir}/worktrees/[^/]+/(config|config\\.worktree|commondir|gitdir)$|^${dir}/modules/.+/(config|config\\.worktree|commondir|gitdir)$|^${dir}/modules/.+/hooks(/|$)`,
    'i',
  );
};

const commonGitDirs = new Map<string, string>();

// The session cwd's common git dir, normalized, or null when there is none. Mirrors the sandbox's
// `gitDirToBind` (src/tools/_sandbox.ts) minus its "cwd's own `.git`" skip:
// for the file tools the name rules already cover a `.git`-named dir, and protecting it again here
// changes nothing, so the skip is a comparison that cannot differ in outcome. A found dir is cached
// per cwd; a null is not, so a `--separate-git-dir`/bare repo the user creates mid-session is still
// probed for on the next write.
function commonGitDir(cwd: string): string | null {
  const cached = commonGitDirs.get(cwd);
  if (cached !== undefined) return cached;
  let dir: string | null = null;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (out) {
      // Real path, as the sandbox binds it: git prints a separate git dir already resolved, so a
      // cwd behind a symlink (`/tmp`, `os.tmpdir()`) would otherwise never match it.
      dir = realTarget(resolve(isAbsolute(out) ? out : resolve(cwd, out)));
    }
  } catch {
    // not a repo, or no git — nothing to protect beyond the name rules
  }
  if (dir !== null) commonGitDirs.set(cwd, dir);
  return dir;
}

// Where a write to `full` actually lands: the real path of its deepest existing ancestor plus the
// rest, with a dangling symlink followed by hand (writeFile creates its target). The sandbox gets
// this from the kernel; a string check does not, and a sandboxed `ln -s .git/hooks h` is an
// ordinary in-project write that would turn `write h/pre-commit` into a hook.
function realTarget(full: string): string {
  let head = full;
  const tail: string[] = [];
  for (let hops = 0; hops < 40; hops++) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch {
      // does not exist (yet), or a dangling link — handled below
    }
    try {
      if (lstatSync(head).isSymbolicLink()) {
        head = resolve(dirname(head), readlinkSync(head));
        continue;
      }
    } catch {
      // nothing there
    }
    const parent = dirname(head);
    if (parent === head) return full;
    tail.unshift(basename(head));
    head = parent;
  }
  return full;
}

// Whether a resolved path is git metadata that names a program, and the warning to raise when it
// is. Undefined for anything else, so the tools' `warnings` arrays stay absent for a normal write.
// Both the path as written and where it really lands are checked: either one naming git metadata
// is enough.
export function gitMetadataWarning(cwd: string, full: string): string | undefined {
  const targets = [...new Set([full, realTarget(full)])].map(p => p.replaceAll('\\', '/'));
  if (targets.some(f => GIT_METADATA_NAME_RE.test(f))) return GIT_METADATA_WARNING;
  const g = commonGitDir(cwd);
  if (!g) return undefined;
  const deny = GIT_DIR_DENY_RE(g.replaceAll('\\', '/'));
  return targets.some(f => deny.test(f)) ? GIT_METADATA_WARNING : undefined;
}
