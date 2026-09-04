#!/usr/bin/env tsx
// Margin report for the verbatim-abort ratio bar — the instrument for the question the lowered
// threshold raises, which is NOT a rate question. Nothing should ever be cut on a healthy run, so
// counting aborts measures nothing until the day one fires. What you actually want is the DISTANCE
// between the ratios real reasoning produces and the bar that would cut it.
//
// So this reports, per session, the highest selfRepeat any reasoning block reached and how much
// headroom was left under the bar for a block of that length. A sweep of healthy runs topping out
// around 0.02 says the bar is nowhere near; one reaching 0.25 is a near-miss worth reading even
// though nothing was cut.
//
// Reads saved transcripts (always written, and they carry the reasoning text itself, so the real
// threshold function can be applied) and optionally debug logs, which are the only place an actual
// abort and the session's build/flags are recorded.
//
// Usage:
//   npx tsx evals/selfrepeat-report.ts                       # every saved session
//   npx tsx evals/selfrepeat-report.ts ~/.config/reika/history/2026-*.jsonl
//   npx tsx evals/selfrepeat-report.ts ~/reika-debug.log     # actual aborts + flags for one run
//
// Unlike readtrace-report.ts this is a breadth instrument, not a rate one: prefer one run each
// across several DIFFERENT reasoning shapes (plan mode, an enumerative task, review, issue) over
// repeated runs of the same task. Parallel reasoning — ticking through many similar items — is what
// legitimately raises a self-repeat ratio, so that is the shape a false positive would come from.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { selfRepeatRatio, verbatimAbortThreshold } from '../src/agent/reasoningtrace.js';

const HISTORY_DIR = join(homedir(), '.config', 'reika', 'history');
// Below this a ratio says nothing (verbatimAbortThreshold refuses to fire under it either), so these
// blocks are counted but never ranked — including them would report noise as the session's maximum.
const MIN_BLOCK_CHARS = 2000;
// Fraction of the bar at which a block stops being comfortable and starts being worth reading. Not a
// threshold the harness uses — purely how this report decides what to draw attention to.
const NEAR_MISS_FRACTION = 0.6;

type Block = { chars: number; ratio: number; bar: number };
type Session = { label: string; task: string; blocks: Block[]; skipped: number };

// First real user message shapes the reasoning profile, which is the axis this sweep varies. The
// `/review` skill body arrives as the user turn, so match its opening rather than a slash command.
function classify(text: string): string {
  const t = text.trim();
  if (t.startsWith('Your first action')) return 'review';
  if (/^\/\w/.test(t)) return 'skill';
  if (/\bissue\b/i.test(t.slice(0, 80))) return 'issue';
  return 'general';
}

function readSession(path: string): Session | null {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return null;
  }
  const firstUser = rows.find(r => r.role === 'user' && typeof r.content === 'string' && r.content);
  const blocks: Block[] = [];
  let skipped = 0;
  for (const r of rows) {
    const rsn = r.reasoning;
    if (typeof rsn !== 'string' || rsn.length === 0) continue;
    if (rsn.length < MIN_BLOCK_CHARS) {
      skipped++;
      continue;
    }
    blocks.push({
      chars: rsn.length,
      ratio: selfRepeatRatio(rsn),
      bar: verbatimAbortThreshold(rsn.length),
    });
  }
  return {
    label: path.slice(-13, -6),
    task: classify(typeof firstUser?.content === 'string' ? firstUser.content : ''),
    blocks,
    skipped,
  };
}

// An abort that actually fired, plus the build it fired on. `reason=ratio` on a turn that was
// reasoning legitimately is the failure this whole report exists to catch early; `reason=length` is
// the hard ceil and unrelated to the bar.
function reportLog(path: string): void {
  const text = readFileSync(path, 'utf8');
  const flags = text.split('\n').find(l => l.includes('[reika:debug] flags '));
  // Anchor on the debug line's own shape: the `flags` line contains the literal `verbatim-abort=1`,
  // so a bare substring match reports every run as a cut.
  const aborts = text.split('\n').filter(l => /\[reika:debug\] verbatim-abort round=/.test(l));
  const rounds = text.split('\n').filter(l => l.includes('reasoning-loop round='));
  console.log(`\n=== ${path}`);
  console.log(
    `  ${flags ? flags.replace('[reika:debug] ', '') : 'no flags line — build identity unknown (pre-188bb03)'}`,
  );
  const ratios = rounds
    .map(l => Number(/selfRepeat=([0-9.]+)/.exec(l)?.[1] ?? NaN))
    .filter(n => !Number.isNaN(n));
  if (ratios.length > 0) {
    console.log(
      `  ${ratios.length} rounds logged, max selfRepeat=${Math.max(...ratios).toFixed(2)}`,
    );
  }
  if (aborts.length === 0) {
    console.log('  no verbatim-abort — nothing was cut this run');
    return;
  }
  for (const a of aborts) console.log(`  CUT  ${a.replace('[reika:debug] ', '').trim()}`);
  console.log(
    '  ^ reason=ratio on legitimate reasoning is a false positive; reason=length is the hard ceil',
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const logs = args.filter(a => a.endsWith('.log'));
  for (const l of logs) reportLog(l);

  const jsonl = args.filter(a => a.endsWith('.jsonl'));
  const paths =
    jsonl.length > 0
      ? jsonl
      : logs.length > 0
        ? []
        : readdirSync(HISTORY_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => join(HISTORY_DIR, f));
  if (paths.length === 0) return;

  const sessions = paths.map(readSession).filter((s): s is Session => s !== null);
  const ranked = sessions
    .filter(s => s.blocks.length > 0)
    .map(s => {
      const worst = s.blocks.reduce((a, b) => (b.ratio / b.bar > a.ratio / a.bar ? b : a));
      return { s, worst, headroom: worst.bar - worst.ratio };
    })
    .sort((a, b) => b.worst.ratio / b.worst.bar - a.worst.ratio / a.worst.bar);

  console.log(`\n=== ${ranked.length} sessions with a block >=${MIN_BLOCK_CHARS} chars`);
  console.log('  session  task     blocks   worst  chars    bar   headroom');
  for (const { s, worst, headroom } of ranked) {
    const near = worst.ratio >= worst.bar * NEAR_MISS_FRACTION;
    console.log(
      `  ${s.label.padEnd(8)} ${s.task.padEnd(8)} ${String(s.blocks.length).padStart(6)}   ` +
        `${worst.ratio.toFixed(3)}  ${String(worst.chars).padStart(6)}  ` +
        `${Number.isFinite(worst.bar) ? worst.bar.toFixed(2) : '  n/a'}   ` +
        `${Number.isFinite(headroom) ? headroom.toFixed(3) : '  n/a'}${near ? '   <-- NEAR MISS' : ''}`,
    );
  }

  const all = ranked.flatMap(r => r.s.blocks);
  const rs = all.map(b => b.ratio).sort((a, b) => a - b);
  const q = (p: number) => rs[Math.floor(p * (rs.length - 1))];
  console.log(
    `\n  ${all.length} blocks: median=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)} max=${q(1).toFixed(3)}`,
  );
  const cut = all.filter(b => b.ratio >= b.bar).length;
  const near = all.filter(b => b.ratio < b.bar && b.ratio >= b.bar * NEAR_MISS_FRACTION).length;
  console.log(
    `  would be cut by the current bar: ${cut}   near misses (>=${NEAR_MISS_FRACTION} of bar): ${near}`,
  );
  console.log(`  longest block seen: ${Math.max(...all.map(b => b.chars))} chars`);
  const long = all.filter(b => b.chars >= 16000);
  console.log(
    `  blocks >=16000 chars (where the bar starts descending): ${long.length}` +
      (long.length > 0 ? `, worst ratio ${Math.max(...long.map(b => b.ratio)).toFixed(3)}` : ''),
  );
  console.log(
    '\n  Read it as a margin, not a verdict: a healthy sweep should show 0 cut, few near misses,\n' +
      '  and a worst-case ratio far under the bar. The long-block end is the thin one — few real\n' +
      '  sessions produce a block past 16k chars, so that count is the number to watch grow.',
  );
}

main();
