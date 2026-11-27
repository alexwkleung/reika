// Measures how a model reacts to the dropped-output note, per saved session, for an A/B of its
// wording: rounds whose reasoning talks about dropped output or a context limit, re-reads of lines
// still in context, and edits that landed. A model that reads the note as a new message re-reads
// what it still has; the first two should fall. A re-read counts when it overlaps an earlier read of
// the same file with no trim notice between them, so nothing can have dropped it: a lower bound,
// since a read a trim kept also counts as gone, and a multi-command shell read is not parsed.
//
//   pnpm exec tsx evals/dropnote-report.ts <session.jsonl ...>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseBashFileRead } from '../src/agent/bashread.js';

const NOTE_TALK =
  /context[- ]limit|outputs? (?:are|is|were|was|got|get) (?:now )?dropped|summary-only|re-run (?:the|that) calls?/i;

type Range = { path: string; from: number; to: number };
type Line = {
  role?: string;
  content?: string;
  reasoning?: string;
  summary?: string;
  callId?: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
};

const READ_SUMMARY = /^Read (\S+) lines (\d+)-(\d+) of \d+/;

function readRange(m: Line, calls: Map<string, { name: string; args: Record<string, unknown> }>) {
  const hit = READ_SUMMARY.exec(m.summary ?? '');
  if (hit) return { path: hit[1], from: Number(hit[2]), to: Number(hit[3]) };
  const call = m.callId ? calls.get(m.callId) : undefined;
  if (call?.name !== 'bash' || !(m.summary ?? '').startsWith('Ran: ')) return undefined;
  const b = parseBashFileRead(String(call.args.command ?? ''));
  if (!b || !('from' in b.range)) return undefined;
  const to = b.range.count === undefined ? Infinity : b.range.from + b.range.count - 1;
  return { path: b.path.replace(/^\.\//, ''), from: b.range.from, to };
}

function report(file: string): string {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0]) as { model?: string; usage?: { contextWindow?: number } };
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  let held: Range[] = [];
  let rounds = 0;
  let noteRounds = 0;
  let liveRereads = 0;
  let edits = 0;
  for (const line of lines.slice(1)) {
    const m = JSON.parse(line) as Line;
    if (m.role === 'user' && !(m.content ?? '').startsWith('/')) held = [];
    if (m.role === 'system' && /^Context (trimmed|compacted)/.test(m.content ?? '')) held = [];
    if (m.role === 'assistant') {
      rounds++;
      if (NOTE_TALK.test(m.reasoning ?? '')) noteRounds++;
      for (const c of m.toolCalls ?? []) calls.set(c.id, c);
    }
    if (m.role !== 'tool') continue;
    if (/^(Edited|Wrote) /.test(m.summary ?? '')) {
      edits++;
      held = [];
      continue;
    }
    const r = readRange(m, calls);
    if (!r) continue;
    if (held.some(h => h.path === r.path && h.from <= r.to && r.from <= h.to)) liveRereads++;
    held.push(r);
  }
  return (
    `${basename(file)} model=${header.model ?? '?'} window=${header.usage?.contextWindow ?? '?'}` +
    ` rounds=${rounds} note-talk=${noteRounds} live-rereads=${liveRereads} edits=${edits}`
  );
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: pnpm exec tsx evals/dropnote-report.ts <session.jsonl ...>');
  process.exit(1);
}
for (const f of files) console.log(report(f));
