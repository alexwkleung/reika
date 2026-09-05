#!/usr/bin/env tsx
// Where a run's prefill time actually went — issue #253's instrument. The `prefix-cache` debug line
// reports how much of a request diverged from the previous one, but a diverged region is two very
// different things mixed together:
//
//   growth           — content that is NEW this round. It has never been processed and never could
//                      have been cached. Nothing can make it cheaper; it is not overhead.
//   reprocessed-old  — bytes the engine had ALREADY processed and had to process again because
//                      something earlier in the prompt was rewritten under them. This is the only
//                      number worth optimizing, and it is the one no single log line shows.
//
// The split is arithmetic: reprocessed-old = diverged - growth, where growth is this request's total
// minus the previous request's. On the run #253 was filed from it separated a constant ~436 chars of
// per-round noise from 110,421 chars concentrated in three shrink events — ~24 minutes of a 2h15m
// run, and ~60% of all prefill. Those are opposite conclusions about where to spend effort, and the
// raw lines look the same either way.
//
// Shrink events are attributed, not guessed: `batch-age` and `compaction` write their own debug
// lines immediately before the request they rewrite, so each round is labelled with the mechanism
// that actually fired in it.
//
// Usage:
//   npx tsx evals/prefixcost-report.ts ~/reika-debug.log
//   npx tsx evals/prefixcost-report.ts a.log b.log          # two arms, compared
//   npx tsx evals/prefixcost-report.ts --rounds run.log     # per-round table (the issue's table)
//
// This is a per-run instrument, not a rate one: one healthy run tells you where its own time went.
// Comparing AGE_LOW_FRACTION settings (REIKA_AGE_LOW_FRACTION) is a different question and needs
// 3+ runs per arm — a shrink event's cost is deterministic, but how many events a run has depends
// on how the model happens to fill the window.
import { readFileSync } from 'node:fs';

type Round = {
  turn: number;
  round: number;
  cause: string;
  stableChars: number;
  totalChars: number;
  reprocessTokens: number;
  bounded: boolean;
  rate?: number;
  // Mechanisms whose debug lines preceded this request (`batch-age`, `compaction`).
  shrink: string[];
  // Filled in the second pass, once the previous request in the same turn is known.
  growth: number;
  reprocessedOld: number;
};

type Run = {
  label: string;
  flags: string;
  rounds: Round[];
  // Last rate the run learned; the fallback for rounds whose line printed `rate=?`.
  finalRate?: number;
};

const NUM = (s: string, re: RegExp): number | undefined => {
  const m = re.exec(s);
  return m ? Number(m[1]) : undefined;
};

function parse(path: string): Run {
  const text = readFileSync(path, 'utf8');
  const flagLine = text.split('\n').find(l => l.includes('[reika:debug] flags '));
  const rounds: Round[] = [];
  let pendingShrink: string[] = [];
  let turn = -1;
  let finalRate: number | undefined;

  for (const line of text.split('\n')) {
    // Shrink mechanisms log just before the request they rewrite, so they belong to the next
    // prefix-cache line. `marked=0` / `removed=0` never log at all, so presence means it fired.
    if (line.includes('batch-age marked=')) pendingShrink.push('batch-age');
    else if (line.includes('compaction removed=')) pendingShrink.push('compaction');

    if (!line.includes('] prefix-cache round=')) continue;
    const cause = /cause=(\S+)/.exec(line)?.[1] ?? '?';
    const stableChars = NUM(line, /stable=(\d+)\/\d+c/);
    const totalChars = NUM(line, /stable=\d+\/(\d+)c/);
    if (stableChars == null || totalChars == null) continue;
    // A turn's first request has no baseline: its numbers are a ceiling, not a measurement, and its
    // "growth" against the previous turn's last request is meaningless. Start a new turn here.
    if (cause === 'first-request') turn++;
    const rate = NUM(line, /rate=([\d.]+)t\/s/);
    if (rate != null) finalRate = rate;
    rounds.push({
      turn: Math.max(turn, 0),
      round: NUM(line, /round=(\d+)/) ?? 0,
      cause,
      stableChars,
      totalChars,
      reprocessTokens: NUM(line, /reprocess[=≤](\d+)tok/) ?? 0,
      bounded: line.includes('reprocess≤'),
      rate,
      shrink: pendingShrink,
      growth: 0,
      reprocessedOld: 0,
    });
    pendingShrink = [];
  }

  // Second pass: growth is measured against the previous request OF THE SAME TURN.
  let prevTotal: number | null = null;
  let prevTurn = -1;
  for (const r of rounds) {
    if (r.turn !== prevTurn || r.cause === 'first-request') prevTotal = null;
    prevTurn = r.turn;
    const diverged = r.totalChars - r.stableChars;
    r.growth = prevTotal == null ? diverged : r.totalChars - prevTotal;
    // Everything diverged that was not new. A turn's first request has no baseline, so it is scored
    // as all-growth (0 old) rather than credited with a re-process it cannot demonstrate.
    r.reprocessedOld = prevTotal == null ? 0 : diverged - r.growth;
    prevTotal = r.totalChars;
  }

  return {
    label: path.split('/').pop() ?? path,
    flags: flagLine ?? '(no flags line)',
    rounds,
    finalRate,
  };
}

// Chars are the unit the split is computed in; tokens are the unit time is charged in. Each round
// carries both for its own diverged region, so its own ratio converts the split without importing a
// chars-per-token guess from anywhere else.
function tokensOf(r: Round, chars: number): number {
  const diverged = r.totalChars - r.stableChars;
  if (diverged <= 0 || r.reprocessTokens <= 0) return 0;
  return (chars / diverged) * r.reprocessTokens;
}

function seconds(run: Run, r: Round, tokens: number): number | undefined {
  const rate = r.rate ?? run.finalRate;
  return rate && rate > 0 ? tokens / rate : undefined;
}

function fmtSeconds(s: number | undefined): string {
  if (s == null) return '?';
  if (s >= 90) return `${(s / 60).toFixed(1)}m`;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

function isShrink(r: Round): boolean {
  return r.shrink.length > 0;
}

function roundsTable(run: Run): void {
  console.log('  turn round cause            diverged   growth  reproc-old   est  mechanism');
  for (const r of run.rounds) {
    const old = r.reprocessedOld;
    console.log(
      `  ${String(r.turn).padStart(4)} ${String(r.round).padStart(5)} ` +
        `${r.cause.padEnd(15)} ${String(r.totalChars - r.stableChars).padStart(8)} ` +
        `${String(r.growth).padStart(8)} ${String(old).padStart(11)} ` +
        `${fmtSeconds(old > 0 ? seconds(run, r, tokensOf(r, old)) : 0).padStart(5)}  ` +
        `${r.shrink.join('+')}`,
    );
  }
}

function report(run: Run, showRounds: boolean): void {
  console.log(`\n=== ${run.label} ===`);
  console.log(`  ${run.flags.replace('[reika:debug] ', '')}`);
  if (run.rounds.length === 0) {
    console.log('  no prefix-cache lines — was REIKA_DEBUG set for this run?');
    return;
  }
  if (showRounds) roundsTable(run);

  const shrink = run.rounds.filter(isShrink);
  const ordinary = run.rounds.filter(r => !isShrink(r) && !r.bounded);
  const sum = (rs: Round[], f: (r: Round) => number): number => rs.reduce((a, r) => a + f(r), 0);

  const oldTokens = (rs: Round[]): number =>
    sum(rs, r => tokensOf(r, Math.max(r.reprocessedOld, 0)));
  const oldSeconds = (rs: Round[]): number =>
    sum(rs, r => seconds(run, r, tokensOf(r, Math.max(r.reprocessedOld, 0))) ?? 0);
  // Every round's full reprocess — growth included — is the run's whole prefill bill, the
  // denominator that says whether the overhead below is worth an engineering week. Bounded rounds
  // (a turn's first request, printed with `≤`) are excluded: the engine usually still holds the
  // previous turn's prefix, so their number is a ceiling and counting it inflates the denominator —
  // which would make every percentage below read SMALLER than it is.
  const measured = run.rounds.filter(r => !r.bounded);
  const allSeconds = sum(measured, r => seconds(run, r, r.reprocessTokens) ?? 0);

  const pct = (s: number): string =>
    allSeconds > 0 ? `${Math.round((s / allSeconds) * 100)}%` : '?';

  const bounded = run.rounds.length - measured.length;
  console.log(`  rounds=${run.rounds.length} turns=${(run.rounds.at(-1)?.turn ?? 0) + 1}`);
  console.log(
    `  total prefill (growth included): ${fmtSeconds(allSeconds)}` +
      (bounded
        ? ` — over ${measured.length} measured rounds, ${bounded} first-request excluded`
        : ''),
  );

  const sSec = oldSeconds(shrink);
  console.log(
    `  shrink events: ${shrink.length}` +
      (shrink.length
        ? ` — reprocessed-old ${Math.round(sum(shrink, r => Math.max(r.reprocessedOld, 0)))}c ` +
          `(~${Math.round(oldTokens(shrink))}tok, ${fmtSeconds(sSec)}, ${pct(sSec)} of prefill)`
        : ''),
  );
  for (const r of shrink) {
    console.log(
      `      turn ${String(r.turn).padStart(3)} round ${String(r.round).padStart(3)} ` +
        `${r.shrink.join('+').padEnd(20)} ` +
        `${String(Math.max(r.reprocessedOld, 0)).padStart(7)}c  ` +
        `${fmtSeconds(seconds(run, r, tokensOf(r, Math.max(r.reprocessedOld, 0))))}`,
    );
  }

  const oSec = oldSeconds(ordinary);
  const oChars = ordinary.map(r => Math.max(r.reprocessedOld, 0)).sort((a, b) => a - b);
  const median = oChars.length ? oChars[Math.floor(oChars.length / 2)] : 0;
  console.log(
    `  ordinary rounds: ${ordinary.length} — reprocessed-old ${Math.round(sum(ordinary, r => Math.max(r.reprocessedOld, 0)))}c ` +
      `(${fmtSeconds(oSec)}, ${pct(oSec)} of prefill), median ${median}c/round`,
  );
  // A flat median across rounds of wildly different sizes is the signature of a fixed-size tail
  // (the transient harness note) rather than history churn — the misreading #253 names.
  const flat = oChars.length > 3 && oChars[0] === oChars.at(-1);
  if (flat && median > 0) {
    console.log(`      constant ${median}c on every ordinary round — a fixed tail, not churn.`);
  }

  const causes = new Map<string, number>();
  for (const r of run.rounds) causes.set(r.cause, (causes.get(r.cause) ?? 0) + 1);
  console.log(
    `  causes: ${[...causes]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}=${n}`)
      .join(' ')}`,
  );
}

const args = process.argv.slice(2);
const showRounds = args.includes('--rounds');
const paths = args.filter(a => !a.startsWith('--'));
if (paths.length === 0) {
  console.error('usage: npx tsx evals/prefixcost-report.ts [--rounds] <debug.log> [more.log ...]');
  process.exit(1);
}
for (const p of paths) report(parse(p), showRounds);
console.log();
