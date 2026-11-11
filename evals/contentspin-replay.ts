#!/usr/bin/env tsx
// False-positive instrument for the content-spin gate (#944) — the number that decides whether
// CONTENT_SPIN_RATIO / CONTENT_SPIN_MIN_CHARS hold, and the one to re-run before moving either.
//
// Nothing on a healthy run is ever cut, so counting cuts in debug logs measures nothing (same
// argument as selfrepeat-report.ts, which does this for the reasoning bar). What you want instead is
// the distance between the ratios real OUTPUT produces and the bar, over text that was good enough
// to be committed as a reply. Saved transcripts hold exactly that: the committed content, no
// reconstruction.
//
// The gate is judged the way the stream judges it, not on the whole reply at once: the prefix is
// walked in CONTENT_SPIN_DEBOUNCE steps and every prefix goes through the real contentSpinSignal, so
// the report says what a live run would have DONE (cut at N chars) rather than what the finished
// text would score. That distinction is the whole measurement — a reply that loops for 20k chars and
// then recovers is a healthy commit with a firing prefix, and it is the shape a false positive takes.
//
// Usage:
//   npx tsx evals/contentspin-replay.ts                       # every saved session
//   npx tsx evals/contentspin-replay.ts ~/.config/reika/history/projects/<name>-<hash>/*.jsonl
//
// Read the output as a margin: 0 cuts, a worst-case ratio far under 0.8, and every judged block far
// under the bar. A block that DOES fire is either a real content loop (the gate earning its keep) or
// the shape that would be cut wrongly — read it before changing anything.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONTENT_SPIN_DEBOUNCE,
  CONTENT_SPIN_MIN_CHARS,
  CONTENT_SPIN_RATIO,
  contentSpinSignal,
} from '../src/agent/contentspin.js';

const HISTORY_DIR = join(homedir(), '.config', 'reika', 'history');
// Fraction of the bar a block reaches before it is worth reading even though nothing would be cut.
const NEAR_MISS_FRACTION = 0.6;

// TUI sessions auto-save under projects/<name>-<hash>/; the root holds only /save transcripts and
// sessions from before auto-save, so a root-only listing misses most of the corpus.
function collectFiles(target: string, out: string[]): string[] {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isFile()) {
    if (target.endsWith('.jsonl')) out.push(target);
    return out;
  }
  for (const name of readdirSync(target)) collectFiles(join(target, name), out);
  return out;
}

type Block = {
  chars: number;
  // The strongest ratio any stepped prefix reached — 0 for a block never long enough to judge.
  ratio: number;
  // Total content chars fed in, so the log line says how far into the reply the verdict landed.
  judged: boolean;
  // Where the live gate would have cut, if it would.
  cut: { chars: number; ratio: number; fence: boolean } | null;
};
type Session = { label: string; blocks: Block[]; skipped: number };

// Walk the block the way the loop's debounce does: the first prefix that trips the gate is the cut,
// and later prefixes are never reached on a live run.
function judge(content: string): Block {
  let ratio = 0;
  let judged = false;
  if (content.length >= CONTENT_SPIN_MIN_CHARS) {
    judged = true;
    // The gate is only consulted on the debounce, and never before the minimum length, so start at
    // the first tick at or past it rather than at 0.
    for (let n = CONTENT_SPIN_MIN_CHARS; n <= content.length; n += CONTENT_SPIN_DEBOUNCE) {
      const r = contentSpinSignal(content.slice(0, n));
      ratio = Math.max(ratio, r.ratio);
      if (r.spinning)
        return {
          chars: content.length,
          ratio,
          judged,
          cut: { chars: n, ratio: r.ratio, fence: r.fence },
        };
    }
    // The tail tick, in case the reply ends between steps.
    const r = contentSpinSignal(content);
    ratio = Math.max(ratio, r.ratio);
    if (r.spinning)
      return {
        chars: content.length,
        ratio,
        judged,
        cut: { chars: content.length, ratio: r.ratio, fence: r.fence },
      };
  }
  return { chars: content.length, ratio, judged, cut: null };
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
  const blocks: Block[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.role !== 'assistant') continue;
    const content = r.content;
    if (typeof content !== 'string' || content.length === 0) continue;
    if (content.length < CONTENT_SPIN_MIN_CHARS) {
      skipped++;
      continue;
    }
    blocks.push(judge(content));
  }
  return { label: path.slice(-13, -6), blocks, skipped };
}

function main(): void {
  const args = process.argv.slice(2);
  const paths = args.length > 0 ? args : collectFiles(HISTORY_DIR, []);
  if (paths.length === 0) {
    console.log(`no transcripts under ${HISTORY_DIR}`);
    return;
  }

  const sessions = paths.map(readSession).filter((s): s is Session => s !== null);
  const judged = sessions
    .filter(s => s.blocks.length > 0)
    .map(s => ({
      s,
      worst: s.blocks.reduce((a, b) => (b.ratio > a.ratio ? b : a)),
    }))
    .sort((a, b) => b.worst.ratio - a.worst.ratio);

  const all = judged.flatMap(r => r.s.blocks);
  console.log(
    `\n=== ${paths.length} transcripts, ${sessions.reduce((n, s) => n + s.skipped, 0)} assistant ` +
      `replies under ${CONTENT_SPIN_MIN_CHARS} chars skipped`,
  );
  console.log(
    `  gate: ratio >= ${CONTENT_SPIN_RATIO}, judged past ${CONTENT_SPIN_MIN_CHARS} chars`,
  );
  console.log(`  ${all.length} replies reach the judged length\n`);
  if (all.length === 0) {
    console.log('  nothing to judge — run more sessions, or read this as the corpus being short');
    return;
  }

  console.log('  session  blocks  worst  chars   window  fence');
  for (const { s, worst } of judged) {
    console.log(
      `  ${s.label.padEnd(8)} ${String(s.blocks.length).padStart(6)}  ` +
        `${worst.ratio.toFixed(3)}  ${String(worst.chars).padStart(6)}   ` +
        `${String(worst.cut?.chars ?? '-').padStart(6)}  ${worst.cut ? (worst.cut.fence ? 'yes' : 'no ') : '-'}`,
    );
  }

  const rs = all.map(b => b.ratio).sort((a, b) => a - b);
  const q = (p: number) => rs[Math.floor(p * (rs.length - 1))];
  console.log(
    `\n  ratio over ${rs.length} judged replies: median=${q(0.5).toFixed(3)} ` +
      `p90=${q(0.9).toFixed(3)} p99=${q(0.99).toFixed(3)} max=${q(1).toFixed(3)}`,
  );
  const cut = all.filter(b => b.cut !== null);
  const near = all.filter(
    b => b.cut === null && b.ratio >= CONTENT_SPIN_RATIO * NEAR_MISS_FRACTION,
  );
  console.log(
    `  would be cut: ${cut.length}   near misses (>=${NEAR_MISS_FRACTION} of bar): ${near.length}`,
  );
  for (const b of cut) {
    console.log(
      `  CUT at ${b.cut?.chars} chars (ratio ${b.cut?.ratio.toFixed(3)}, fence=${b.cut?.fence ? 'yes' : 'no'}) ` +
        `of a ${b.chars}-char reply`,
    );
  }
  console.log(
    '\n  A healthy sweep shows 0 cuts and a worst-case ratio far under 0.8. A cut is either a real\n' +
      '  content loop or the false positive this gate was tuned to avoid — read the reply before\n' +
      '  deciding which, and re-run with more sessions before moving either threshold.',
  );
}

main();
