import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { structuredPatch } from 'diff';
import type { FileChange, DiffHunk, TreeChanges } from '../types.js';
import { mapLimit } from '../limit.js';
import { MAX_EDIT_LENGTH } from './_diff.js';
import { writeTargets } from './_writetargets.js';

// What a bash command did to the working tree, as a diff the UI can draw (#278). A model that
// edits through `sed -i` or a heredoc gets the same visual receipt the edit tool gives, so the
// user isn't reading a cut-off command and guessing what landed.
//
// Git is the change detector, not the command text: parsing a shell command for its write targets
// is a losing game (`npm run fix`, `prettier --write .`, a heredoc piped into python), and git
// already keeps the one thing a diff needs — the previous bytes of every clean file. So the
// snapshot only has to hold the files git ALREADY reports dirty (their previous bytes live nowhere
// else); anything clean before the run diffs against the commit HEAD was on. That commit is part
// of the snapshot (#337): a `git checkout`, `merge`, `reset`, or an edit committed in the same
// call leaves the tree clean against the NEW head, so status lists nothing — the files that changed
// are the ones `git diff old..new` names, and their previous bytes are at the old commit. Outside a
// repo the fallback is the command text after all (_writetargets.ts): deterministic, and a best
// shot — it snapshots the files the command names and diffs those, and cannot see what a formatter
// touched.
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
// Reads in flight at once across a snapshot. Above the dozens a working session has, so the common
// case is as wide as it was; at the entry cap it holds the live buffers to 64 × SNAPSHOT_MAX_BYTES
// instead of 2000 open files (#338).
const READ_CONCURRENCY = 64;
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
  // The repo root, or null when there is no repo and `before` holds the command's named targets.
  root: string | null;
  // The commit HEAD was on. `null` without a repo, or before the first commit.
  head: string | null;
  cwd: string;
  // Repo-relative path (absolute without a repo) → bytes before the command, for every path git
  // reported as dirty or untracked. `null` = listed but absent on disk (a pending delete, or a
  // named target that doesn't exist yet).
  before: Map<string, Bytes>;
  // Listed, but too large to keep. Never diffed: with no previous bytes there is nothing to
  // compare against and claiming "unchanged" would be a guess.
  skipped: Set<string>;
};

// Capture the state a diff will be taken against. `null` when git is present but can't answer
// (slow, or too much untracked to read), which callers treat as "no diff" rather than an error.
export async function snapshotTree(cwd: string, command: string): Promise<TreeSnapshot | null> {
  const [root, head] = await Promise.all([
    git(['rev-parse', '--show-toplevel'], cwd),
    git(['rev-parse', 'HEAD'], cwd),
  ]);
  // git reports the resolved root; the cwd must be resolved the same way or a project under a
  // symlinked dir (macOS /tmp → /private/tmp) gets every path as a long `../` chain.
  const realCwd = await realpath(cwd).catch(() => cwd);
  const snap: TreeSnapshot = {
    root: root?.trim() ?? null,
    head: head?.trim() ?? null,
    cwd: realCwd,
    before: new Map(),
    skipped: new Set(),
  };
  let paths: string[];
  if (snap.root === null) {
    paths = writeTargets(command, realCwd);
  } else {
    const listed = await dirtyPaths(snap.root);
    if (listed === null || listed.size > MAX_DIRTY_ENTRIES) return null;
    paths = [...listed.keys()];
  }
  await mapLimit(paths, READ_CONCURRENCY, async p => {
    const bytes = await readBounded(snap.root === null ? p : join(snap.root, p));
    if (bytes === 'oversize') snap.skipped.add(p);
    else snap.before.set(p, bytes);
  });
  return snap;
}

// Every file whose bytes differ from the snapshot, in path order. A file git lists now but didn't
// before was clean, so it changed and the old head holds its previous bytes. One it listed before
// but not now was reverted, committed, or (if untracked) deleted — the snapshot vs. the disk
// decides which of those actually changed the bytes, so a `git commit` of an existing edit shows
// nothing. When HEAD moved, the files that differ between the two commits are candidates too:
// clean against both, they are in no status listing.
export async function changesSince(snap: TreeSnapshot): Promise<TreeChanges | null> {
  if (snap.root === null) return namedChanges(snap);
  const root = snap.root;
  const [listed, head] = await Promise.all([dirtyPaths(root), git(['rev-parse', 'HEAD'], root)]);
  if (listed === null) return null;
  const moved = snap.head !== null && head !== null && head.trim() !== snap.head;
  const between = moved
    ? await commitDiff(root, snap.head!, head!.trim())
    : new Map<string, string>();
  if (between === null) return null;
  const candidates = [
    ...new Set([...listed.keys(), ...snap.before.keys(), ...between.keys()]),
  ].filter(p => !snap.skipped.has(p));
  // Decide what changed without keeping any bytes: a `git checkout` can name thousands of files,
  // and only the ones drawn below are read again.
  const changed: { path: string; created: boolean }[] = [];
  await mapLimit(candidates, READ_CONCURRENCY, async p => {
    if (snap.before.has(p)) {
      const after = await readBounded(join(root, p));
      if (after === 'oversize' || snap.before.get(p)?.text === after?.text) return;
      changed.push({ path: p, created: false });
      return;
    }
    // Clean before the run, so it changed. Created unless the old head had it — which the commit
    // diff says outright, and status says only when HEAD is where it was.
    const created = between.has(p)
      ? between.get(p) === 'A'
      : listed.get(p) === '??' || listed.get(p)?.[0] === 'A';
    changed.push({ path: p, created });
  });
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: FileChange[] = [];
  for (const c of changed.slice(0, MAX_DIFFED_FILES)) {
    const after = await readBounded(join(root, c.path));
    if (after === 'oversize') continue;
    let before: Bytes;
    if (snap.before.has(c.path)) {
      before = snap.before.get(c.path)!;
    } else if (c.created) {
      before = null;
    } else {
      // The old head's bytes, fetched only for files that get rendered — a formatter sweeping 200
      // files must not cost 200 git processes. `--filters` applies the same eol/smudge conversion
      // the worktree copy went through, so a CRLF checkout doesn't diff as a full-file rewrite. A
      // miss (no commit had the path, yet it wasn't listed before) or a mode-only change has
      // nothing to draw.
      const old = await git(
        ['cat-file', '--filters', `${snap.head ?? 'HEAD'}:${c.path}`],
        root,
        'buffer',
      );
      if (old === null) continue;
      before = decode(old);
      if (before.text === after?.text) continue;
    }
    files.push(describeChange(relative(snap.cwd, join(root, c.path)), before, after));
  }
  if (files.length === 0) return null;
  return { files, more: changed.length - Math.min(changed.length, MAX_DIFFED_FILES) };
}

// No repo: the only files that can be compared are the ones the command named, and every one of
// them was snapshotted, so this is a straight before/after over that set.
async function namedChanges(snap: TreeSnapshot): Promise<TreeChanges | null> {
  const files: FileChange[] = [];
  let changed = 0;
  for (const [p, before] of [...snap.before].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const after = await readBounded(p);
    if (after === 'oversize' || before?.text === after?.text) continue;
    changed++;
    if (files.length < MAX_DIFFED_FILES)
      files.push(describeChange(relative(snap.cwd, p), before, after));
  }
  if (files.length === 0) return null;
  return { files, more: changed - files.length };
}

function describeChange(path: string, before: Bytes, after: Bytes): FileChange {
  if (before?.binary || after?.binary) {
    return { path, kind: 'binary', hunks: [], added: 0, removed: 0 };
  }
  // A created or deleted file has nothing to pair, so it never goes through Myers: its rows are
  // one side's lines, and the cap below must not be able to bail on a 2k-line file the command
  // wrote whole.
  if (before === null || after === null) {
    const kind = before === null ? 'created' : 'deleted';
    const marker = before === null ? '+' : '-';
    const rows = splitLines((before ?? after)!.text).map(l => `${marker} ${l}`);
    return { path, kind, ...foldRows([{ rows, startLine: 1, oldStartLine: 1 }]) };
  }
  const patch = structuredPatch('', '', before.text, after.text, '', '', {
    context: CONTEXT_LINES,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  // Past the cap (see _diff.ts): the file shares too little with its previous bytes for a diff to
  // be worth its cost, or to read as anything but a rewrite. Say so, with the two sizes, rather
  // than 80 rows of `-`.
  if (patch === undefined) {
    return {
      path,
      kind: 'rewritten',
      hunks: [],
      added: splitLines(after.text).length,
      removed: splitLines(before.text).length,
    };
  }
  const hunks = patch.hunks.map(h => ({
    // jsdiff's "\ No newline at end of file" annotation: a fact about bytes, not a line. Same
    // two-char markers the edit tool emits, so DiffView reads both identically.
    rows: h.lines.filter(l => !l.startsWith('\\')).map(l => `${l[0]} ${l.slice(1)}`),
    startLine: h.newStart,
    oldStartLine: h.oldStart,
  }));
  return { path, kind: 'modified', ...foldRows(hunks) };
}

// Count every row, draw the first MAX_ROWS_PER_FILE, fold the rest into `omitted`.
function foldRows(
  hunks: { rows: string[]; startLine: number; oldStartLine: number }[],
): Pick<FileChange, 'hunks' | 'added' | 'removed' | 'omitted'> {
  const out: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let rows = 0;
  let omitted = 0;
  for (const h of hunks) {
    const lines: string[] = [];
    for (const l of h.rows) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
      if (rows >= MAX_ROWS_PER_FILE) {
        omitted++;
        continue;
      }
      lines.push(l);
      rows++;
    }
    if (lines.length > 0) {
      out.push({ text: lines.join('\n'), startLine: h.startLine, oldStartLine: h.oldStartLine });
    }
  }
  return { hunks: out, added, removed, ...(omitted > 0 ? { omitted } : {}) };
}

// Lines as a diff counts them: a trailing newline ends the last line, it doesn't start an empty one.
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
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

// Paths whose content differs between two commits, with git's letter for each (A/M/D/T). Renames
// are left undetected on purpose: the old path is gone from disk and the new one appeared, and a
// deleted-plus-created pair is what the tree actually did.
async function commitDiff(
  root: string,
  from: string,
  to: string,
): Promise<Map<string, string> | null> {
  const out = await git(['diff', '--name-status', '--no-renames', '-z', from, to], root);
  if (out === null) return null;
  const paths = new Map<string, string>();
  const tokens = out.split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 2) paths.set(tokens[i + 1], tokens[i][0]);
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
