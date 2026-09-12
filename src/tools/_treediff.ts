import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { structuredPatch } from 'diff';
import type { FileChange, DiffHunk, TreeChanges } from '../types.js';

// What a bash command did to the working tree, as a diff the UI can draw (#278). A model that
// edits through `sed -i` or a heredoc gets the same visual receipt the edit tool gives, so the
// user isn't reading a cut-off command and guessing what landed.
//
// Git is the change detector, not the command text: parsing a shell command for its write targets
// is a losing game (`npm run fix`, `prettier --write .`, a heredoc piped into python), and git
// already keeps the one thing a diff needs — the previous bytes of every clean file. So the
// snapshot only has to hold the files git ALREADY reports dirty (their previous bytes live nowhere
// else); anything clean before the run diffs against HEAD. Outside a repo there is no detector and
// nothing is shown — an honest gap, not a guess.
//
// Display-only, like `ToolResult.diff`: nothing here reaches the model. The summary and payload the
// model sees are byte-identical with or without it.

const GIT_TIMEOUT_MS = 3_000;
// Above this, a file's previous bytes aren't kept and it is left out of the diff. Well past any
// source file; keeps a stray lockfile or fixture from costing a copy per bash call.
const SNAPSHOT_MAX_BYTES = 512 * 1024;
// Dirty entries past which the snapshot is skipped altogether. Reading every dirty file twice per
// bash call is free at the dozens a working session has and not at the thousands an untracked
// build or data directory has; showing nothing there beats a visible pause on every command.
const MAX_DIRTY_ENTRIES = 2000;
// Files that get a rendered diff. Past this they are still counted (`more`), because a `git
// checkout` touching 300 files is something the user should see the size of, not the body of.
const MAX_DIFFED_FILES = 8;
// Diff rows per file before the rest is folded into `omitted`.
const MAX_ROWS_PER_FILE = 80;
const CONTEXT_LINES = 3;

// A file's bytes as text, or as a lossless latin1 string when they aren't text (equality still
// works; only the diff body is withheld). `null` = absent on disk.
type Content = { text: string; binary: boolean };
type Bytes = Content | null;

export type TreeSnapshot = {
  root: string;
  cwd: string;
  // Repo-relative path → bytes before the command, for every path git reported as dirty or
  // untracked. `null` = the entry was listed but the file was absent on disk (a pending delete).
  before: Map<string, Bytes>;
  // Listed, but too large to keep. Never diffed: with no previous bytes there is nothing to
  // compare against and claiming "unchanged" would be a guess.
  skipped: Set<string>;
};

// Capture the state a diff will be taken against. `null` when `cwd` isn't in a git repo (or git
// is unavailable/slow), which callers treat as "no diff" rather than an error.
export async function snapshotTree(cwd: string): Promise<TreeSnapshot | null> {
  const root = await git(['rev-parse', '--show-toplevel'], cwd);
  if (root === null) return null;
  const listed = await dirtyPaths(root.trim());
  if (listed === null || listed.size > MAX_DIRTY_ENTRIES) return null;
  // git reports the resolved root; the cwd must be resolved the same way or a project under a
  // symlinked dir (macOS /tmp → /private/tmp) gets every path as a long `../` chain.
  const snap: TreeSnapshot = {
    root: root.trim(),
    cwd: await realpath(cwd).catch(() => cwd),
    before: new Map(),
    skipped: new Set(),
  };
  await Promise.all(
    [...listed.keys()].map(async p => {
      const bytes = await readBounded(join(snap.root, p));
      if (bytes === 'oversize') snap.skipped.add(p);
      else snap.before.set(p, bytes);
    }),
  );
  return snap;
}

// Every file whose bytes differ from the snapshot, in path order. A file git lists now but didn't
// before was clean, so it changed and HEAD holds its previous bytes. One it listed before but not
// now was reverted, committed, or (if untracked) deleted — the snapshot vs. the disk decides which
// of those actually changed the bytes, so a `git commit` of an existing edit shows nothing.
export async function changesSince(snap: TreeSnapshot): Promise<TreeChanges | null> {
  const listed = await dirtyPaths(snap.root);
  if (listed === null) return null;
  const candidates = [...new Set([...listed.keys(), ...snap.before.keys()])].filter(
    p => !snap.skipped.has(p),
  );
  // `before: undefined` = tracked and clean before the run; its HEAD bytes are fetched below, and
  // only for the files that get rendered — a formatter sweeping 200 files must not cost 200 git
  // processes. A path HEAD doesn't have (untracked, or staged as new) was created by the command.
  const changed: { path: string; before: Bytes | undefined; after: Bytes }[] = [];
  await Promise.all(
    candidates.map(async p => {
      const after = await readBounded(join(snap.root, p));
      if (after === 'oversize') return;
      if (snap.before.has(p)) {
        const before = snap.before.get(p)!;
        if (before?.text !== after?.text) changed.push({ path: p, before, after });
        return;
      }
      const code = listed.get(p) ?? '';
      const created = code === '??' || code[0] === 'A';
      changed.push({ path: p, before: created ? null : undefined, after });
    }),
  );
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: FileChange[] = [];
  for (const c of changed.slice(0, MAX_DIFFED_FILES)) {
    let before = c.before;
    if (before === undefined) {
      // `--filters` applies the same eol/smudge conversion the worktree copy went through, so a
      // CRLF checkout doesn't diff as a full-file rewrite. A miss (HEAD never had the path, yet it
      // wasn't listed before) or a mode-only change has nothing to draw.
      const head = await git(['cat-file', '--filters', `HEAD:${c.path}`], snap.root, 'buffer');
      if (head === null) continue;
      const decoded = decode(head);
      if (decoded.text === c.after?.text) continue;
      before = decoded;
    }
    files.push(describeChange(relative(snap.cwd, join(snap.root, c.path)), before, c.after));
  }
  if (files.length === 0) return null;
  return { files, more: changed.length - Math.min(changed.length, MAX_DIFFED_FILES) };
}

function describeChange(path: string, before: Bytes, after: Bytes): FileChange {
  const kind = before === null ? 'created' : after === null ? 'deleted' : 'modified';
  if (before?.binary || after?.binary) {
    return { path, kind: 'binary', hunks: [], added: 0, removed: 0 };
  }
  const patch = structuredPatch('', '', before?.text ?? '', after?.text ?? '', '', '', {
    context: CONTEXT_LINES,
  });
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let rows = 0;
  let omitted = 0;
  for (const h of patch.hunks) {
    const lines: string[] = [];
    for (const l of h.lines) {
      // jsdiff's "\ No newline at end of file" annotation: a fact about bytes, not a line.
      if (l.startsWith('\\')) continue;
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
      if (rows >= MAX_ROWS_PER_FILE) {
        omitted++;
        continue;
      }
      // Same two-char markers the edit tool emits, so DiffView reads both identically.
      lines.push(`${l[0]} ${l.slice(1)}`);
      rows++;
    }
    if (lines.length > 0) {
      hunks.push({ text: lines.join('\n'), startLine: h.newStart, oldStartLine: h.oldStart });
    }
  }
  return { path, kind, hunks, added, removed, ...(omitted > 0 ? { omitted } : {}) };
}

// `git status` lists tracked files that differ from HEAD or the index, plus untracked ones. Ignored
// files are deliberately absent: a build writing into `dist/` is not an edit the user wants a diff
// of, and it's the same rule the file index and the read tools already apply.
async function dirtyPaths(root: string): Promise<Map<string, string> | null> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (out === null) return null;
  const paths = new Map<string, string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    paths.set(entry.slice(3), entry.slice(0, 2));
    // A rename/copy carries its origin as the next NUL-separated token. The origin is gone from
    // disk (or, for a copy, untouched), so it isn't a candidate.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

async function readBounded(path: string): Promise<Bytes | 'oversize'> {
  try {
    const buf = await readFile(path);
    if (buf.length > SNAPSHOT_MAX_BYTES) return 'oversize';
    return decode(buf);
  } catch {
    return null;
  }
}

// Git's own heuristic (a NUL in the first 8KB) plus one of ours: bytes that aren't valid UTF-8
// aren't text either, and 100 random bytes can dodge the NUL test while still being noise.
function decode(buf: Buffer): Content {
  const text = buf.toString('utf8');
  const binary = buf.subarray(0, 8000).includes(0) || text.includes('\uFFFD');
  return { text: binary ? buf.toString('latin1') : text, binary };
}

function git(args: string[], cwd: string): Promise<string | null>;
function git(args: string[], cwd: string, as: 'buffer'): Promise<Buffer | null>;
function git(args: string[], cwd: string, as?: 'buffer'): Promise<string | Buffer | null> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: as === 'buffer' ? 'buffer' : 'utf8',
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}
