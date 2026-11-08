#!/usr/bin/env tsx
// Replays every saved `bash` command through the sandbox's `networkAllowedFor` at two builds — a git
// ref and the working tree — and prints every command whose verdict changed. The instrument for "did
// this change to the network classifier cost a real command its allow" (#910). A lost allow is a
// false deny only when the command actually needs the network (a fetch, a `gh` read); a local
// `git log` that loses it runs exactly as before.
//
// Same corpus and caveats as `danger-replay.ts`: every session under `~/.config/reika/history`,
// commands deduplicated by exact text, and a clean report says nothing about a shape nobody has run.
//
// Usage:
//   npx tsx evals/network-replay.ts [--ref=main] [--skip=<path substring>]... [--full]
//
// The commands are quoted verbatim from the user's sessions, so do not paste the output into the repo.
//
// Result of the run #910 shipped on (606 session files; 12,034 distinct commands), `main` against its
// branch: 2,147 allowed → 2,138, 0 gained, 9 lost — every one a local-only git command (`xargs git
// log`, a `for c in …; do git log $c` loop, `git log -- docs/*`, `git worktree add`), none needing the
// network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Allowed = (command: string) => boolean;

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

// The ref's classifier comes from a detached worktree of it, so the comparison is two shipped builds.
const worktree = mkdtempSync(join(tmpdir(), 'reika-network-replay-'));
let verdicts: Array<{ command: string; before: boolean; after: boolean }>;
try {
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-q', '--detach', worktree, ref]);
  const before = (await import(join(worktree, 'src/tools/_sandbox.ts')))
    .networkAllowedFor as Allowed;
  const after = (await import(join(repoRoot, 'src/tools/_sandbox.ts')))
    .networkAllowedFor as Allowed;
  verdicts = [...commands].map(command => ({
    command,
    before: before(command),
    after: after(command),
  }));
} finally {
  execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree]);
  rmSync(worktree, { recursive: true, force: true });
}

const show = (c: string) => (full ? c : c.slice(0, 200).replace(/\n/g, '⏎'));
const lost = verdicts.filter(v => v.before && !v.after).map(v => show(v.command));
const gained = verdicts.filter(v => !v.before && v.after).map(v => show(v.command));
console.log(
  `files=${files.length}${skips.length > 0 ? ` (--skip ${skips.join(', ')})` : ''} ` +
    `distinctCommands=${commands.size}`,
);
console.log(
  `allowed: ${ref}=${verdicts.filter(v => v.before).length} ` +
    `working tree=${verdicts.filter(v => v.after).length}`,
);
console.log(`lost the allow: ${lost.length}, gained it: ${gained.length}`);
if (lost.length > 0) console.log(`\n== lost the allow ==\n${lost.map(c => `  ${c}`).join('\n')}`);
if (gained.length > 0)
  console.log(`\n== gained the allow ==\n${gained.map(c => `  ${c}`).join('\n')}`);
