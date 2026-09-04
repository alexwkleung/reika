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

type Flags = Map<string, string>;

// The `flags` line each session writes (src/debug.ts formatExperimentFlags). Absent in any log from
// a build older than that line — which is itself the signal that an arm's build identity is unknown.
function parseFlags(text: string): Flags | null {
  const line = text.split('\n').find(l => l.includes('[reika:debug] flags '));
  if (!line) return null;
  const flags: Flags = new Map();
  for (const tok of line.slice(line.indexOf('flags ') + 6).split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) flags.set(tok.slice(0, eq), tok.slice(eq + 1));
  }
  return flags;
}

// What actually differs between two arms. An A/B whose arms differ in nothing is not an A/B, and an
// A/B that differs in several things cannot attribute its result to any one of them — both are worth
// saying out loud before anyone reads a percentage.
function flagDiff(a: Flags, b: Flags): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys]
    .sort()
    .filter(k => (a.get(k) ?? 'unset') !== (b.get(k) ?? 'unset'))
    .map(k => `${k}: ${a.get(k) ?? 'unset'} -> ${b.get(k) ?? 'unset'}`);
}

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

function parse(path: string): {
  turns: Turn[];
  pinRounds: number;
  pinHolding: number;
  flags: Flags | null;
  ledgerRounds: number;
  ledgerActive: number;
} {
  const text = readFileSync(path, 'utf8');
  const flags = parseFlags(text);
  const lines = text.split('\n');
  let ledgerRounds = 0;
  let ledgerActive = 0;
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
    } else if (line.includes('dropped-ledger')) {
      ledgerRounds++;
      if (line.includes('active=true')) ledgerActive++;
    }
  }
  return { turns, pinRounds, pinHolding, flags, ledgerRounds, ledgerActive };
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
  console.log(
    r.ledgerRounds === 0
      ? '  dropped-ledger: no lines at all — this build does NOT contain the ledger code'
      : `  dropped-ledger: ${r.ledgerActive}/${r.ledgerRounds} rounds active`,
  );
  console.log(
    `  flags: ${r.flags ? [...r.flags].map(([k, v]) => `${k}=${v}`).join(' ') : 'UNKNOWN — log predates the flags line'}`,
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
  // Guard the comparison before anyone reads a percentage off it. The failure this exists for: an
  // arm was run from a build that did not contain the feature, so the flag it set was read by
  // nothing and both arms were the same configuration — which by filename looked like a clean pair.
  console.log('\n=== arm validity');
  if (first.ledgerRounds === 0 || second.ledgerRounds === 0) {
    const which = first.ledgerRounds === 0 ? 'A' : 'B';
    console.log(
      `  STOP: arm ${which} has no dropped-ledger lines, so that build does not contain the\n` +
        `  feature. Whatever REIKA_DROPPED_LEDGER was set to, nothing read it. Not an A/B.`,
    );
  }
  if (!first.flags || !second.flags) {
    console.log(
      '  WARNING: at least one arm predates the flags line — build identity unverifiable.',
    );
  } else {
    const diff = flagDiff(first.flags, second.flags);
    if (diff.length === 0) {
      console.log(
        '  NOTE: identical flags — these arms are the SAME configuration. The numbers below are a\n' +
          '  variance baseline (how much these move for no reason), not a treatment effect.',
      );
    } else {
      console.log(`  arms differ in: ${diff.join(', ')}`);
      if (diff.length > 1) {
        console.log(
          '  WARNING: more than one difference — a result cannot be attributed to any one.',
        );
      }
    }
  }
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
