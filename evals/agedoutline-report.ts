#!/usr/bin/env tsx
// What the aged-read outline actually keeps, measured over real saved sessions rather than
// fixtures (#269). The question it answers is a COVERAGE question — which file shapes does the
// structure rule see, and which age to a bare summary line — and a corpus you built cannot answer
// it, because you would only put shapes in it you had already thought of. Hence: real transcripts.
//
//   npx tsx evals/agedoutline-report.ts                 # last 12 sessions in ~/.config/reika/history
//   npx tsx evals/agedoutline-report.ts 30              # last 30
//   npx tsx evals/agedoutline-report.ts ~/somewhere     # a different history directory
//
// Read the `kept nothing` column: a class piling up there is a structure rule that does not fit
// that shape (#269 was filed off exactly this — test files at 29%, markdown and JSON at 0%). Add
// the extension to CODE_EXTENSIONS or give the shape its own rule, then re-run this.
//
// The report is about SERIALIZATION, so it needs no model and no run: it replays saved payloads
// through the real agedContentChars. Live rate — how often a payload ages at all — is the
// `aged-payload` debug line's job, not this one's.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agedContentChars } from '../src/provider/toolcall.js';

type Row = { outline: number; whole: number; nothing: number; nothingBytes: number };

function classOf(path: string): string {
  if (/\.(test|spec)\.[tj]sx?$/.test(path)) return 'test file';
  if (/\.(md|markdown)$/.test(path)) return 'markdown';
  if (/\.jsonc?$/.test(path)) return 'json';
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return path.includes('.') ? `${ext} source` : 'no extension';
}

function main(): void {
  const arg = process.argv[2];
  const dir = arg && !/^\d+$/.test(arg) ? arg : join(homedir(), '.config/reika/history');
  const limit = arg && /^\d+$/.test(arg) ? Number(arg) : 12;
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .slice(-limit);
  const tally = new Map<string, Row>();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d: { role?: string; summary?: string; payload?: string };
      try {
        d = JSON.parse(line) as typeof d;
      } catch {
        continue;
      }
      if (d.role !== 'tool' || !d.payload || !d.summary?.startsWith('Read ')) continue;
      const path = d.summary.slice(5).split(' ')[0];
      const cls = classOf(path);
      const row = tally.get(cls) ?? { outline: 0, whole: 0, nothing: 0, nothingBytes: 0 };
      const chars = agedContentChars({
        role: 'tool',
        callId: 'x',
        summary: d.summary,
        payload: d.payload,
      });
      if (chars === d.summary.length) {
        row.nothing++;
        row.nothingBytes += d.payload.length;
      } else if (chars === d.summary.length + 2 + d.payload.length) row.whole++;
      else row.outline++;
      tally.set(cls, row);
    }
  }
  const rows = [...tally.entries()].sort(
    (a, b) => b[1].outline + b[1].nothing - (a[1].outline + a[1].nothing),
  );
  console.log(`sessions: ${files.length} (${dir})\n`);
  console.log('file class          outlined  kept whole  kept nothing   bytes lost');
  let tot = { outline: 0, whole: 0, nothing: 0, nothingBytes: 0 };
  for (const [cls, r] of rows) {
    console.log(
      `${cls.padEnd(20)}${String(r.outline).padStart(8)}${String(r.whole).padStart(12)}` +
        `${String(r.nothing).padStart(14)}${String(Math.round(r.nothingBytes / 1024) + 'KB').padStart(13)}`,
    );
    tot = {
      outline: tot.outline + r.outline,
      whole: tot.whole + r.whole,
      nothing: tot.nothing + r.nothing,
      nothingBytes: tot.nothingBytes + r.nothingBytes,
    };
  }
  const reads = tot.outline + tot.whole + tot.nothing;
  const pct = reads > 0 ? Math.round((100 * (tot.outline + tot.whole)) / reads) : 0;
  console.log(
    `\n${reads} read payloads, ${pct}% keep something ` +
      `(${tot.outline} outlined, ${tot.whole} whole, ${tot.nothing} summary-only, ` +
      `${Math.round(tot.nothingBytes / 1024)}KB lost)`,
  );
}

main();
