#!/usr/bin/env tsx
// Per-turn report over a REIKA_DEBUG log — the instrument for the two questions #227's changes
// raise, both of which are RATE questions (how often), so they want repetition against the same
// task rather than a fixture eval.
//
//   REIKA_DROPPED_LEDGER (#227 part 2): does telling the model "re-run that call if you need it"
//   make it re-fetch aged results? `dup-aged`, `maxrepeat` and `looped` are that, directly.
//
//   The task-spec pin (#227 part 1): is it holding when it should? `spec-pin … holding=true` means
//   the spec has fallen outside the trailing block and the pin is the only reason it survives.
//
// Usage:
//   npx tsx evals/readtrace-report.ts ~/reika-debug.log
//   npx tsx evals/readtrace-report.ts on.log off.log      # two arms, compared
//
// Per Alex's rule on small-model variance, one run per arm proves nothing — concatenate 3+ runs
// per arm (`cat run*.log > on.log`) and read the aggregate line, not the per-turn rows.
import { readFileSync } from 'node:fs';

type Turn = {
  unique: number;
  changed: number;
  dupLive: number;
  dupAged: number;
  narrowed: number;
  maxrepeat: number;
  looped: number;
};

const NUM = (s: string, key: string): number => {
  const m = new RegExp(`${key}=(-?\\d+)`).exec(s);
  return m ? Number(m[1]) : 0;
};

function parse(path: string): { turns: Turn[]; pinRounds: number; pinHolding: number } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const turns: Turn[] = [];
  let pinRounds = 0;
  let pinHolding = 0;
  for (const line of lines) {
    if (line.includes('read-trace-summary')) {
      turns.push({
        unique: NUM(line, 'unique'),
        changed: NUM(line, 'changed'),
        dupLive: NUM(line, 'dup-live'),
        dupAged: NUM(line, 'dup-aged'),
        narrowed: NUM(line, 'narrowed'),
        maxrepeat: NUM(line, 'maxrepeat'),
        looped: NUM(line, 'looped'),
      });
    } else if (line.includes('spec-pin')) {
      // `spec-pin none` rounds count as observed-but-not-pinned, so the ratio is meaningful.
      pinRounds++;
      if (line.includes('holding=true')) pinHolding++;
    }
  }
  return { turns, pinRounds, pinHolding };
}

const sum = (ts: Turn[], k: keyof Turn): number => ts.reduce((n, t) => n + t[k], 0);
const mean = (ts: Turn[], k: keyof Turn): number => (ts.length ? sum(ts, k) / ts.length : 0);

function report(label: string, path: string): ReturnType<typeof parse> {
  const r = parse(path);
  console.log(`\n=== ${label} (${path}) — ${r.turns.length} turns`);
  if (r.turns.length === 0) {
    console.log('  no read-trace-summary lines; was REIKA_DEBUG set for this run?');
  } else {
    console.log('  turn  unique  changed  dup-live  dup-aged  narrowed  maxrepeat  looped');
    r.turns.forEach((t, i) => {
      console.log(
        `  ${String(i + 1).padStart(4)}  ${String(t.unique).padStart(6)}  ${String(t.changed).padStart(7)}  ` +
          `${String(t.dupLive).padStart(8)}  ${String(t.dupAged).padStart(8)}  ${String(t.narrowed).padStart(8)}  ` +
          `${String(t.maxrepeat).padStart(9)}  ${String(t.looped).padStart(6)}`,
      );
    });
    console.log(
      `  mean/turn: dup-aged=${mean(r.turns, 'dupAged').toFixed(2)} ` +
        `dup-live=${mean(r.turns, 'dupLive').toFixed(2)} ` +
        `maxrepeat=${mean(r.turns, 'maxrepeat').toFixed(2)} ` +
        `looped=${mean(r.turns, 'looped').toFixed(2)}`,
    );
  }
  console.log(
    `  spec-pin: ${r.pinHolding}/${r.pinRounds} rounds holding` +
      (r.pinRounds === 0 ? ' (no spec-pin lines — pre-#228 build?)' : ''),
  );
  return r;
}

const [a, b] = process.argv.slice(2);
if (!a) {
  console.error('usage: tsx evals/readtrace-report.ts <log> [<log-to-compare>]');
  process.exit(1);
}
const first = report(b ? 'arm A' : 'log', a);
if (b) {
  const second = report('arm B', b);
  const d = (k: keyof Turn): string => {
    const x = mean(first.turns, k);
    const y = mean(second.turns, k);
    const pct = x === 0 ? (y === 0 ? 0 : Infinity) : ((y - x) / x) * 100;
    return `${x.toFixed(2)} → ${y.toFixed(2)} (${pct === Infinity ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`})`;
  };
  console.log('\n=== A → B, mean per turn');
  console.log(`  dup-aged:  ${d('dupAged')}   <- the re-fetch cost the notice risks`);
  console.log(`  dup-live:  ${d('dupLive')}`);
  console.log(`  maxrepeat: ${d('maxrepeat')}`);
  console.log(`  looped:    ${d('looped')}`);
  console.log(
    '\n  A rise in dup-aged with no fall in confabulation is the notice failing to earn its place.',
  );
}
