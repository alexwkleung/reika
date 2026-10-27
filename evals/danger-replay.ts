#!/usr/bin/env tsx
// Replays every saved `bash` command through `detectDangerousPatterns` at two builds — a git ref and
// the working tree — and prints every command whose labels changed. The instrument for "did this
// change to the approval labels lose one a real command earned" (#699, #749, #752, #757, #794 each
// ran this by hand, and their totals could not be compared, since nobody could say which files a
// run had read).
//
// The corpus is every session under `~/.config/reika/history`: the root (`/save` and pre-#1
// autosaves) and `projects/` alike. Commands are deduplicated by exact text, so a command run in ten
// sessions counts once.
//
// What it cannot answer: a command nobody has run yet. A clean report is evidence about one machine's
// history, never proof about a shape — the hand-built cases in `_danger.test.ts` are what pin those.
// And the session that BUILT a change is always where its gains come from (its probes write out the
// new shapes), so `--skip` takes those sessions out; read what remains.
//
// Usage:
//   npx tsx evals/danger-replay.ts [--ref=main] [--skip=<path substring>]... [--full]
//
// `--full` prints whole commands instead of the first 200 characters. The commands are quoted
// verbatim from the user's sessions, so do not paste the output into the repo.
//
// Result of the run this shipped on (427 session files, 99 root + 328 projects; 10,015 distinct
// commands), `main` against #843's branch: 1,938 flagged → 1,939, 0 commands lost a label, 6 gained
// one — five `env -S` probes inside pasted heredoc bodies from the session that built it, and a
// `node -e` body holding the string `'install'`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

type Detect = (command: string) => string[];

const historyRoot = join(homedir(), '.config/reika/history');
const repoRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ref = args.find(a => a.startsWith('--ref='))?.slice('--ref='.length) ?? 'main';
const skips = args.filter(a => a.startsWith('--skip=')).map(a => a.slice('--skip='.length));
const full = args.includes('--full');

function sessionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sessionFiles(p, out);
    else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// No history (autosave off, a fresh install) is an empty corpus, not a crash.
const files = (existsSync(historyRoot) ? sessionFiles(historyRoot) : []).filter(
  f => !skips.some(s => f.includes(s)),
);
const commands = new Set<string>();
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"bash"')) continue;
    let rec: { toolCalls?: Array<{ name?: string; args?: { command?: unknown } }> };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    for (const call of rec.toolCalls ?? []) {
      if (call.name === 'bash' && typeof call.args?.command === 'string') {
        commands.add(call.args.command);
      }
    }
  }
}

// The ref's detector is imported from a detached worktree of it rather than reimplemented, so the
// comparison is two shipped builds and cannot drift from either. `_danger.ts` imports only node
// builtins and its siblings, so the worktree needs no install.
const worktree = mkdtempSync(join(tmpdir(), 'reika-danger-replay-'));
let labels: Array<{ command: string; before: string[]; after: string[] }>;
try {
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '--detach', worktree, ref]);
  const before = (await import(join(worktree, 'src/tools/_danger.ts')))
    .detectDangerousPatterns as Detect;
  const after = (await import(join(repoRoot, 'src/tools/_danger.ts')))
    .detectDangerousPatterns as Detect;
  labels = [...commands].map(command => ({
    command,
    before: before(command),
    after: after(command),
  }));
} finally {
  execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree]);
  rmSync(worktree, { recursive: true, force: true });
}

const lost: string[] = [];
const gained: string[] = [];
let flaggedBefore = 0;
let flaggedAfter = 0;
for (const { command, before, after } of labels) {
  if (before.length > 0) flaggedBefore++;
  if (after.length > 0) flaggedAfter++;
  const dropped = before.filter(l => !after.includes(l));
  const added = after.filter(l => !before.includes(l));
  if (dropped.length === 0 && added.length === 0) continue;
  const text = full ? command : command.slice(0, 200).replace(/\n/g, '⏎');
  const row = [
    `  ${text}`,
    ...dropped.map(l => `    - ${l}`),
    ...added.map(l => `    + ${l}`),
  ].join('\n');
  // A relabel (one label swapped for another) is listed with the losses: a lost label is the
  // direction that hides a command from the user, so it is the list to read first.
  (dropped.length > 0 ? lost : gained).push(row);
}

const rootFiles = files.filter(f => !relative(historyRoot, f).includes('/')).length;
console.log(
  `files=${files.length} (root=${rootFiles} projects=${files.length - rootFiles}` +
    `${skips.length > 0 ? `, --skip ${skips.join(', ')}` : ''}) distinctCommands=${commands.size}`,
);
console.log(`flagged: ${ref}=${flaggedBefore} working tree=${flaggedAfter}`);
console.log(`commands that lost a label: ${lost.length}, gained only: ${gained.length}`);
if (lost.length > 0) {
  console.log(`\n== lost a label (read these first) ==`);
  for (const row of lost) console.log(row);
}
if (gained.length > 0) {
  console.log(`\n== gained a label ==`);
  for (const row of gained) console.log(row);
}
