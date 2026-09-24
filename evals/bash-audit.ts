#!/usr/bin/env tsx
// Replays every model-run `bash` command in the saved sessions through the approval classifier —
// the instrument for "does the danger scan miss what models actually run, and what does it cost in
// prompts". A fixture can't answer that: the corpus is the user's real history, not one we built.
//
// The first run (1160 unique commands) found no parse failures — every miss was a verb the patterns
// didn't know (`gh pr edit`, `git checkout <file>`), and 70% of flags were `npx` running a local
// binary. That is why the classifier is patterns plus two working-tree checks, not a shell AST;
// re-run this before reopening that question.
//
// Usage:
//   npx tsx evals/bash-audit.ts [outDir] [cwd]
//
// Writes `flagged.txt` and `unflagged-other.txt` (unflagged and not provably read-only — the list
// to read for misses) to outDir (default: cwd). Sessions carry no working directory, so every
// command is classified against `cwd` (default: this process's); a local-bin or checkout verdict
// for a command that ran in another project is approximate. The output quotes commands verbatim,
// so keep it out of the repo.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectDangerousPatterns } from '../src/tools/_danger.js';
import { isProvablyReadOnly } from '../src/tools/_readonly.js';

const outDir = process.argv[2] ?? process.cwd();
const cwd = process.argv[3] ?? process.cwd();
const historyRoot = join(homedir(), '.config/reika/history');

function sessionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sessionFiles(p, out);
    else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

type ToolCallRecord = { toolCalls?: { name: string; args: { command?: unknown } }[] };

const counts = new Map<string, number>();
for (const f of sessionFiles(historyRoot)) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"toolCalls"')) continue;
    let rec: ToolCallRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of rec.toolCalls ?? []) {
      if (c.name === 'bash' && typeof c.args?.command === 'string') {
        counts.set(c.args.command, (counts.get(c.args.command) ?? 0) + 1);
      }
    }
  }
}

const rows = [...counts].map(([cmd, n]) => ({
  cmd,
  n,
  flags: detectDangerousPatterns(cmd, cwd),
  readOnly: isProvablyReadOnly(cmd),
}));
const flagged = rows.filter(r => r.flags.length > 0);
const other = rows.filter(r => r.flags.length === 0 && !r.readOnly);
const format = (r: (typeof rows)[number]) =>
  `[${r.n}] ${r.flags.length ? `{${r.flags.join('; ')}} ` : ''}${r.cmd.replace(/\n/g, '⏎')}`;

const labels = new Map<string, number>();
for (const r of flagged) for (const l of r.flags) labels.set(l, (labels.get(l) ?? 0) + 1);

console.log(
  `unique=${rows.length} flagged=${flagged.length} readonly=${rows.length - flagged.length - other.length} other=${other.length}`,
);
for (const [label, n] of [...labels].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${label}`);
}
writeFileSync(join(outDir, 'flagged.txt'), flagged.map(format).join('\n') + '\n');
writeFileSync(join(outDir, 'unflagged-other.txt'), other.map(format).join('\n') + '\n');
