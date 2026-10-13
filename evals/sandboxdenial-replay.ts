#!/usr/bin/env tsx
// Replays every saved `bash` output through the sandbox write-denial detector, before and after the
// #726 prefix change — the instrument for "did the allowlist drop a runner a real command printed".
//
// A fixture cannot answer that. The shapes #726 is about are prefix shapes (`web:build: `, `[0] `,
// `packages/web build: `, a go error chain) that a runner emits and nobody writes down, so the corpus
// is the user's own history rather than one we built. The question it settles is one-directional:
// the OLD prefix allowed any `<text>: ` in front of a refusal (so a line that only QUOTES one read as
// a real refusal), the NEW prefix allows an enumerated list of runner columns, and every verdict
// that flips is a shape the list does not cover. Those lines are printed verbatim below, which is
// the whole output — read them, then decide whether the list needs a shape added.
//
// What it cannot answer: a shape the history does not happen to contain. A `bash` result keeps only
// the tail of its output (10 lines / 4KB, `bash.ts` `buildCommandDisplay`), so a runner's column
// printed past that window is invisible here; and the history is one machine's, one project's. A
// clean report is evidence about a corpus, never proof about a runner.
//
// Usage:
//   npx tsx evals/sandboxdenial-replay.ts [--all]
//
// `--all` prints every line either grammar hits, not only the changed ones. The lines are quoted
// verbatim from the user's sessions, so do not paste the output into the repo.
//
// Result of the run this shipped on (7,312 bash outputs, 32,353 distinct lines): 32 lines hit by the
// old grammar, 31 by the new, one changed — `AssertionError: /bin/sh: /Users/someone/notes.md:
// Operation not permitted`, the false positive #726 exists for. No runner shape was lost. The corpus
// grows with every session, so a later run's totals will be larger; the changed set is the part to
// read.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { refusedWriteLine } from '../src/tools/_sandbox.js';

const historyRoot = join(homedir(), '.config/reika/history');
const all = process.argv.includes('--all');

function sessionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sessionFiles(p, out);
    else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const outputs: string[] = [];
for (const f of sessionFiles(historyRoot)) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    // A bash result's retained output is `command.outputTail`; `summary` holds it too, but with the
    // chip's own prefix on some rows, so the tail is the field to replay.
    if (!line.includes('"outputTail"')) continue;
    let rec: { command?: { outputTail?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (typeof rec.command?.outputTail === 'string') outputs.push(rec.command.outputTail);
  }
}

// The #720/#723/#725 grammar, frozen: `.*: ` in front of every form, the runner prefix only in front
// of the slashless ones. Kept as a copy because the point of the replay is to compare against it —
// `refusedWriteLine` below is the shipped code, imported rather than reimplemented.
const OLD_PREFIX = String.raw`(?:.*: )?[ \t]*(?:\[[^\]\r\n]*\][ \t]+|[^\s|]+[ \t]+\|[ \t]+)?`;
const OLD_RE = new RegExp(
  [
    String.raw`^(?:.*: (?:[a-z]+ )?[^\s:'"]*|[ \t]*(?:\[[^\]\r\n]*\][ \t]+|[^\s|]+[ \t]+\|[ \t]+)?(?:[a-z]+ )?)\/[^:'"\r\n]*: operation not permitted[ \t]*$`,
    String.raw`^${OLD_PREFIX}(?:rm|mv|cp|mkdir|touch|ln|tee): [^:'"\r\n]*: operation not permitted[ \t]*$`,
    String.raw`^${OLD_PREFIX}sed: rename\(\): operation not permitted[ \t]*$`,
    String.raw`^${OLD_PREFIX}(?:fatal|error): [^\r\n]*'(?![a-z][a-z0-9+.-]*:\/\/)[^'\r\n]*\/[^'\r\n]*': operation not permitted[ \t]*$`,
    String.raw`could not (?:lock|write) config file [^\r\n]*: operation not permitted[ \t]*$`,
    String.raw`EPERM: operation not permitted, \w+ '`,
    String.raw`\[Errno 1\] operation not permitted: '[^'\r\n]+'[ \t]*$`,
  ].join('|'),
  'im',
);

// The ps/top lines are taken out before the write check (a ps refusal is a path by shape and already
// explained by its own note), so the replay has to do the same or it reports the ps note's lines.
const PS_LINE = /^.*?(?:^|: )(?:\/(?:usr\/)?bin\/)?(?:ps|top): Operation not permitted.*$/gm;
const withoutPs = (output: string): string => output.replace(PS_LINE, '');

function hit(re: RegExp, output: string): string | null {
  re.lastIndex = 0;
  const scanned = withoutPs(output);
  const m = re.exec(scanned);
  if (!m) return null;
  const start = scanned.lastIndexOf('\n', m.index) + 1;
  const end = scanned.indexOf('\n', m.index);
  return scanned.slice(start, end === -1 ? undefined : end).trim();
}

const lines = new Set<string>();
for (const output of outputs) for (const l of output.split('\n')) if (l.trim()) lines.add(l);

const changed: string[] = [];
const kept: string[] = [];
let oldHits = 0;
let newHits = 0;
for (const line of lines) {
  const before = hit(OLD_RE, line);
  // The shipped detector is the other half of the comparison, run on the same single line — the real
  // function, so the replay cannot drift from the shape that ships.
  const shipped = refusedWriteLine(line) === null ? null : line.trim();
  if (before !== null) oldHits++;
  if (shipped !== null) newHits++;
  if ((before !== null) !== (shipped !== null)) {
    changed.push(`${before === null ? 'NOW HIT ' : 'NO LONGER'} ${line}`);
  } else if (before !== null) {
    kept.push(line);
  }
}

console.log(
  `files=${sessionFiles(historyRoot).length} bashOutputs=${outputs.length} distinctLines=${lines.size}`,
);
console.log(`lines hit: old=${oldHits} new=${newHits} changed=${changed.length}`);
if (changed.length > 0) {
  console.log(
    '\n== verdicts that changed (a lost runner shape, or the false positive #726 fixes) ==',
  );
  for (const c of changed) console.log(c);
}
if (all) {
  console.log('\n== every line both grammars hit ==');
  for (const k of kept) console.log(`  ${k}`);
}
