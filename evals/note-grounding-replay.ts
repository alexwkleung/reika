// Measures how often a compaction note names a file or symbol the session never looked at (#935),
// before any check is built for it. Each saved note is compared against the scrollback ahead of
// it: a path is `opened` when a read/edit/write targeted it or a bash command named it, `listed`
// when it appears only in tool output or a user message (a grep hit, a listing, the prompt), and
// `unseen` otherwise. A symbol is `seen` when it appears in any earlier tool output, tool argument
// or user message. Existence against the repo is not checked: today's tree is not the tree the note
// was written against, so a later rename would read as an invented file.
//
//   pnpm exec tsx evals/note-grounding-replay.ts [--examples=30] [dir-or-file ...]
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractPlanReferences } from '../src/agent/groundcheck.js';
import { extractTaskPaths } from '../src/agent/subagentreport.js';
import { loadSession } from '../src/store/sessions.js';
import type { Message } from '../src/types.js';

type PathClass = 'opened' | 'listed' | 'unseen';
type Bucket = {
  notes: number;
  notesWithEstablished: number;
  paths: Record<PathClass, number>;
  symbols: { seen: number; unseen: number };
  notesWithUnseen: number;
  refsPerNote: number[];
};
type Example = {
  file: string;
  model: string;
  kind: 'path' | 'listed path' | 'symbol';
  ref: string;
  line: string;
};

// A unbackticked call in prose (`spillResult(name)`), the form these notes write symbols in most.
const CALL_IDENT = /\b([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
const HEADER =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?[A-Za-z][A-Za-z /'&-]{1,40}?(?:\s*\([^)]*\))?\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/;

function looksLikeSymbol(t: string): boolean {
  return t.length >= 3 && (/[_$]/.test(t) || /[a-z][A-Z]/.test(t));
}

function normalize(p: string): string {
  return p
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

// The note's `Established` section(s), and the rest. A section runs from its header line to the
// next header-shaped line that is not a bullet.
function splitSections(note: string): { established: string; other: string } {
  const est: string[] = [];
  const other: string[] = [];
  let inEst = false;
  for (const line of note.split('\n')) {
    const isHeader = HEADER.test(line) && !/^\s*[-*•]\s/.test(line);
    if (isHeader) inEst = /established/i.test(line);
    else if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?established\b/i.test(line)) inEst = true;
    (inEst ? est : other).push(line);
  }
  return { established: est.join('\n'), other: other.join('\n') };
}

function referencesIn(text: string): { paths: string[]; symbols: string[] } {
  const plan = extractPlanReferences(text);
  const paths = new Set([...plan.paths, ...extractTaskPaths(text)].map(normalize));
  const symbols = new Set(plan.symbols);
  for (const m of text.replace(/```[\s\S]*?```/g, ' ').matchAll(CALL_IDENT))
    if (looksLikeSymbol(m[1])) symbols.add(m[1]);
  return { paths: [...paths], symbols: [...symbols] };
}

function pathMatches(ref: string, seen: string): boolean {
  return seen === ref || seen.endsWith('/' + ref) || ref.endsWith('/' + seen);
}

// What the session had in front of it before message `end`.
function evidenceBefore(messages: Message[], end: number) {
  const targeted: string[] = [];
  const edited: string[] = [];
  const commands: string[] = [];
  const text: string[] = [];
  for (const m of messages.slice(0, end)) {
    if (m.role === 'user' && !m.meta) text.push(m.content);
    if (m.role === 'tool') text.push(m.summary ?? '', m.payload ?? '');
    if (m.role === 'assistant' && m.toolCalls) {
      for (const c of m.toolCalls) {
        const p = c.args.path ?? c.args.file_path;
        if (typeof p === 'string' && ['read', 'edit', 'write'].includes(c.name))
          targeted.push(normalize(p.trim()));
        if (typeof p === 'string' && ['edit', 'write'].includes(c.name))
          edited.push(normalize(p.trim()));
        if (typeof c.args.command === 'string') commands.push(c.args.command);
        text.push(JSON.stringify(c.args));
      }
    }
  }
  return { targeted, edited, commands: commands.join('\n'), text: text.join('\n') };
}

function classifyPath(ref: string, ev: ReturnType<typeof evidenceBefore>): PathClass {
  if (ev.targeted.some(t => pathMatches(ref, t))) return 'opened';
  const base = ref.split('/').pop() ?? ref;
  if (ev.commands.includes(ref) || (base.length > 4 && ev.commands.includes(base))) return 'opened';
  if (ev.text.includes(ref) || (base.length > 4 && ev.text.includes(base))) return 'listed';
  return 'unseen';
}

// An Established line that says work was done ("updated X", "Added Y to X").
const DONE_VERB =
  /\b(updated|added|edited|changed|fixed|implemented|wrote|written|created|modified|removed|replaced|renamed)\b/i;
// An Established line that says, in its own words, that it is not established.
const HEDGE =
  /\b(need(s)? to (check|verify|read|confirm)|not (yet )?(verified|checked|read)|unverified|to be confirmed)\b|\(\?\)/i;

// A path a done-line names that no edit or write touched, and no bash command named.
function claimedButUntouched(line: string, ev: ReturnType<typeof evidenceBefore>): string[] {
  if (!DONE_VERB.test(line)) return [];
  return referencesIn(line).paths.filter(p => {
    const base = p.split('/').pop() ?? p;
    return (
      !ev.edited.some(t => pathMatches(p, t)) &&
      !ev.commands.includes(p) &&
      !(base.length > 4 && ev.commands.includes(base))
    );
  });
}

function lineOf(text: string, ref: string): string {
  return (text.split('\n').find(l => l.includes(ref)) ?? '').trim().slice(0, 140);
}

function emptyBucket(): Bucket {
  return {
    notes: 0,
    notesWithEstablished: 0,
    paths: { opened: 0, listed: 0, unseen: 0 },
    symbols: { seen: 0, unseen: 0 },
    notesWithUnseen: 0,
    refsPerNote: [],
  };
}

function sessionFiles(args: string[]): string[] {
  const roots = args.length ? args : [join(homedir(), '.config/reika/history')];
  const out: string[] = [];
  const walk = (p: string) => {
    const s = statSync(p);
    if (s.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (p.endsWith('.jsonl')) out.push(p);
  };
  roots.forEach(walk);
  return out;
}

function headerModel(file: string): string {
  try {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0];
    return (JSON.parse(first) as { model?: string }).model ?? '?';
  } catch {
    return '?';
  }
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : '-';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const exArg = argv.find(a => a.startsWith('--examples='));
  const maxExamples = exArg ? Number(exArg.slice(11)) : 30;
  const files = sessionFiles(argv.filter(a => !a.startsWith('--')));
  // A resumed session carries the earlier scrollback into a new file; count each note once.
  const seenNotes = new Set<string>();
  const buckets = new Map<string, { est: Bucket; other: Bucket }>();
  const byModel = new Map<string, { notes: number; unseen: number; refs: number }>();
  const examples: Example[] = [];
  // Named in Established but only ever seen in tool output: the grey zone worth reading by hand.
  const listed: Example[] = [];
  const lines = new Map<
    string,
    { lines: number; hedged: number; doneLines: number; untouched: number }
  >();
  const untouched: Example[] = [];
  for (const file of files) {
    let messages: Message[];
    try {
      messages = (await loadSession(file)).agent;
    } catch {
      continue;
    }
    const model = headerModel(file);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.compactionNote || !m.content.trim()) continue;
      const hash = createHash('sha1').update(m.content).digest('hex');
      if (seenNotes.has(hash)) continue;
      seenNotes.add(hash);
      const group = m.content.trimStart().startsWith('Established:') ? 'prefilled' : 'unprefilled';
      const b = buckets.get(group) ?? { est: emptyBucket(), other: emptyBucket() };
      buckets.set(group, b);
      const ev = evidenceBefore(messages, i);
      const sections = splitSections(m.content);
      const lc = lines.get(group) ?? { lines: 0, hedged: 0, doneLines: 0, untouched: 0 };
      lines.set(group, lc);
      for (const line of sections.established.split('\n')) {
        if (!/^\s*[-*•]|^\s*\d+\.\s/.test(line)) continue;
        lc.lines++;
        if (HEDGE.test(line)) lc.hedged++;
        if (!DONE_VERB.test(line)) continue;
        lc.doneLines++;
        const miss = claimedButUntouched(line, ev);
        if (miss.length) lc.untouched++;
        for (const p of miss)
          untouched.push({ file, model, kind: 'path', ref: p, line: line.trim().slice(0, 140) });
      }
      let noteUnseen = 0;
      let noteRefs = 0;
      for (const [name, text] of [
        ['est', sections.established],
        ['other', sections.other],
      ] as const) {
        const bucket = b[name];
        bucket.notes++;
        if (name === 'est' && text.trim()) bucket.notesWithEstablished++;
        const refs = referencesIn(text);
        let unseenHere = 0;
        for (const p of refs.paths) {
          const c = classifyPath(p, ev);
          bucket.paths[c]++;
          if (c === 'listed' && name === 'est')
            listed.push({ file, model, kind: 'listed path', ref: p, line: lineOf(text, p) });
          if (c === 'unseen') {
            unseenHere++;
            if (name === 'est')
              examples.push({ file, model, kind: 'path', ref: p, line: lineOf(text, p) });
          }
        }
        for (const s of refs.symbols) {
          const seen = ev.text.includes(s);
          bucket.symbols[seen ? 'seen' : 'unseen']++;
          if (!seen) {
            unseenHere++;
            if (name === 'est')
              examples.push({ file, model, kind: 'symbol', ref: s, line: lineOf(text, s) });
          }
        }
        bucket.refsPerNote.push(refs.paths.length + refs.symbols.length);
        if (unseenHere) bucket.notesWithUnseen++;
        if (name === 'est') {
          noteUnseen += unseenHere;
          noteRefs += refs.paths.length + refs.symbols.length;
        }
      }
      const mm = byModel.get(model) ?? { notes: 0, unseen: 0, refs: 0 };
      mm.notes++;
      mm.unseen += noteUnseen;
      mm.refs += noteRefs;
      byModel.set(model, mm);
    }
  }

  console.log(`${seenNotes.size} distinct notes in ${files.length} files\n`);
  for (const [group, { est, other }] of buckets) {
    console.log(
      `== ${group}: ${est.notes} notes, ${est.notesWithEstablished} with an Established section`,
    );
    for (const [label, bk] of [
      ['Established', est],
      ['rest of note', other],
    ] as const) {
      const pt = bk.paths.opened + bk.paths.listed + bk.paths.unseen;
      const st = bk.symbols.seen + bk.symbols.unseen;
      console.log(
        `  ${label.padEnd(13)} paths ${pt}: opened ${pct(bk.paths.opened, pt)}, listed ${pct(bk.paths.listed, pt)}, unseen ${pct(bk.paths.unseen, pt)}` +
          ` | symbols ${st}: unseen ${pct(bk.symbols.unseen, st)}` +
          ` | refs/note median ${median(bk.refsPerNote)} | notes with any unseen ${pct(bk.notesWithUnseen, bk.notes)}`,
      );
    }
  }
  console.log('\nEstablished bullet lines:');
  for (const [group, v] of lines)
    console.log(
      `  ${group.padEnd(12)} ${v.lines} lines, hedged ${v.hedged} (${pct(v.hedged, v.lines)}),` +
        ` say work was done ${v.doneLines}, of which name a file no edit/write/bash touched ${v.untouched} (${pct(v.untouched, v.doneLines)})`,
    );
  console.log('\nEstablished refs by model (unseen / refs):');
  for (const [model, v] of [...byModel].sort((a, b) => b[1].notes - a[1].notes))
    console.log(
      `  ${model.padEnd(36)} notes ${String(v.notes).padStart(3)}  ${v.unseen}/${v.refs}`,
    );
  console.log(`\nUnseen Established refs (first ${maxExamples} of ${examples.length}):`);
  for (const e of examples.slice(0, maxExamples))
    console.log(`  [${e.kind}] ${e.ref}  (${e.model})\n      ${e.line}`);
  console.log(
    `\nDone-claims naming an untouched file (first ${maxExamples} of ${untouched.length}):`,
  );
  for (const e of untouched.slice(0, maxExamples))
    console.log(`  ${e.ref}  (${e.model})\n      ${e.line}`);
  console.log(
    `\nEstablished paths seen only in output (first ${maxExamples} of ${listed.length}):`,
  );
  for (const e of listed.slice(0, maxExamples))
    console.log(`  ${e.ref}  (${e.model})\n      ${e.line}`);
}

void main();
