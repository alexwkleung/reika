// Prices the read-depth rule's treatment of copies the harness removed. Each saved session's model
// history is re-grown one request at a time at the session's own window through the loop's
// batchAgePayloads + compactHistory, and every read is fed to two ReadTraces: one that stacks every
// earlier fetch (the rule before), one that skips fetches whose copy was shed or folded at the time.
// The loop ladder is replayed per round (ledger once a loop is active, withdrawal on its second
// active round), so the counts are rounds where the model would have been told to stop reading.
// A session with no window is skipped: without one nothing is shed and the two arms agree.
//
//   pnpm exec tsx evals/readdepth-replay.ts [--window=N] [--list] [dir-or-file ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGE_LOW_FRACTION,
  batchAgePayloads,
  compactHistory,
  compactThreshold,
  shouldCompact,
} from '../src/agent/compaction.js';
import { parseBashFileRead, traceReadPath } from '../src/agent/bashread.js';
import { ReadTrace, type ReadVia } from '../src/agent/readtrace.js';
import { estimateRequestTokens } from '../src/provider/tokens.js';
import { loadSession, modelHistoryFromScrollback } from '../src/store/sessions.js';
import type { Message } from '../src/types.js';

const MIN_GEN = 2048;
// Stand-in for the system prompt + tool definitions, which the transcript does not carry.
const SYSTEM = 'x'.repeat(14000);
const READ_RE = /^Read (\S+) lines (\d+)-(\d+) of \d+/;
// The loop's own ladder constants (agent/loop.ts).
const RECENT = 2;
const AGED_MIN = 3;
const LIVE_MIN = 2;
const WITHDRAW_AFTER = 2;
const CALIBRATION = Number(process.env.REPLAY_CALIBRATION ?? 1.15);

type Arm = 'stack-all' | 'skip-removed';
type TurnResult = {
  ledger: boolean;
  withdrawn: boolean;
  firstWithdrawRound?: number;
  editedAfter: boolean;
};
type Case = { file: string; turn: number; round: number; withdrawnIn: Arm[]; editedAfter: boolean };

function cwdOf(file: string): string {
  try {
    return JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).cwd ?? '';
  } catch {
    return '';
  }
}

function windowOf(file: string): number | undefined {
  try {
    const w = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).usage?.contextWindow;
    return typeof w === 'number' && w > 0 ? w : undefined;
  } catch {
    return undefined;
  }
}

function isMutation(m: Message): boolean {
  return (
    m.role === 'tool' && (/^(Edited|Wrote|Created)\b/.test(m.summary) || !!m.changes?.files.length)
  );
}

function replay(source: Message[], window: number, cwd: string): Map<Arm, TurnResult[]> {
  const all = source.map(m => {
    const c = { ...m } as Message;
    if (c.role === 'assistant') delete c.reasoningAged;
    if (c.role === 'tool') {
      delete c.aged;
      delete c.rendered;
    }
    return c;
  });
  const live: Message[] = [];
  // The loop compares a calibrated estimate to the threshold; saved runs learned 1.1-1.2.
  const estimate = () =>
    CALIBRATION *
    estimateRequestTokens(SYSTEM, live, [], {
      contextWindow: window,
      minGenTokens: MIN_GEN,
      prefixStable: true,
    });
  const threshold = compactThreshold(window, MIN_GEN);
  const target = threshold * AGE_LOW_FRACTION;
  const gone = (m: Message) => (m.role === 'tool' && !!m.aged) || !live.includes(m);
  const arms: Arm[] = ['stack-all', 'skip-removed'];
  const out = new Map<Arm, TurnResult[]>(arms.map(a => [a, []]));
  let traces = new Map<Arm, ReadTrace>();
  let active = new Map<Arm, number>();
  let cur = new Map<Arm, TurnResult>();
  let round = -1;
  const version = new Map<string, number>();
  const callArgs = new Map<string, { name: string; args: Record<string, unknown> }>();
  const startTurn = () => {
    // A segment with no request (the history before the first prompt) is not a turn.
    if (round >= 0)
      for (const a of arms) {
        const prev = cur.get(a);
        if (prev) out.get(a)!.push(prev);
      }
    traces = new Map([
      ['stack-all', new ReadTrace()],
      ['skip-removed', new ReadTrace(gone)],
    ]);
    active = new Map(arms.map(a => [a, 0]));
    cur = new Map(arms.map(a => [a, { ledger: false, withdrawn: false, editedAfter: false }]));
    round = -1;
  };
  startTurn();
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (m.role === 'user' && !m.harness && !m.meta) startTurn();
    if (m.role === 'assistant' && live.length > 0) {
      round++;
      for (const a of arms) {
        const r = cur.get(a)!;
        const looping = traces.get(a)!.loopingReads(round, RECENT, AGED_MIN, LIVE_MIN);
        if (process.env.REPLAY_TRACE && looping.length)
          console.log(
            `  ${a} round=${round} ${looping.map(l => `${l.path}:${l.offset}x${l.repeats}`).join(' ')}`,
          );
        const n = looping.length ? active.get(a)! + 1 : 0;
        active.set(a, n);
        if (n >= 1) r.ledger = true;
        if (n >= WITHDRAW_AFTER && !r.withdrawn) {
          r.withdrawn = true;
          r.firstWithdrawRound = round;
        }
      }
      if (estimate() > threshold) {
        const res = batchAgePayloads(live, estimate, window, MIN_GEN);
        if (process.env.REPLAY_TRACE) console.log(`  shed round=${round} marked=${res.marked}`);
        const agedAbove = res.marked > 0 && estimate() > target;
        if (shouldCompact(estimate(), window, MIN_GEN) || agedAbove)
          compactHistory(live, window, 1, MIN_GEN);
      }
      // This request carried every live payload, so each is now frozen at its sent bytes, as the
      // real call path stamps it; unstamped, the estimate prices payloads at the cap and never sheds.
      for (const x of live)
        if (x.role === 'tool' && x.payload && !x.aged && x.rendered === undefined)
          x.rendered = `${x.summary}\n\n${x.payload}`;
      for (const c of m.toolCalls ?? []) callArgs.set(c.id, { name: c.name, args: c.args });
    }
    live.push(m);
    if (m.role !== 'tool') continue;
    if (isMutation(m)) {
      for (const a of arms) {
        const r = cur.get(a)!;
        if (r.withdrawn) r.editedAfter = true;
      }
      const p = callArgs.get(m.callId)?.args.path;
      if (typeof p === 'string') {
        const key = traceReadPath(cwd, p);
        version.set(key, (version.get(key) ?? 0) + 1);
      } else version.clear();
    }
    let read: { path: string; offset: number; limit?: number; via: ReadVia } | undefined;
    const hit = READ_RE.exec(m.summary);
    if (hit) {
      read = {
        path: traceReadPath(cwd, hit[1]),
        offset: Number(hit[2]),
        limit: Number(hit[3]) - Number(hit[2]) + 1,
        via: 'read',
      };
    } else {
      const call = callArgs.get(m.callId);
      if (call?.name === 'bash' && m.exitCode === 0) {
        const b = parseBashFileRead(String(call.args.command ?? ''));
        // A tail read needs the file's length to place it; the transcript has none, so it is left out.
        if (b && !b.dir && 'from' in b.range)
          read = {
            path: traceReadPath(cwd, b.path),
            offset: b.range.from,
            limit: b.range.count,
            via: 'bash',
          };
      }
    }
    if (!read) continue;
    const hash = String(version.get(read.path) ?? 0);
    for (const t of traces.values()) {
      t.record(read.path, read.offset, hash, round, read.limit, read.via);
      t.attachMessage(read.path, m);
    }
  }
  startTurn();
  return out;
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

async function main() {
  const argv = process.argv.slice(2);
  const winArg = argv.find(a => a.startsWith('--window='));
  const forced = winArg ? Number(winArg.slice(9)) : undefined;
  const list = argv.includes('--list');
  const files = sessionFiles(argv.filter(a => !a.startsWith('--')));
  const totals = new Map<Arm, { turns: number; ledger: number; withdrawn: number; edited: number }>(
    (['stack-all', 'skip-removed'] as Arm[]).map(a => [
      a,
      { turns: 0, ledger: 0, withdrawn: 0, edited: 0 },
    ]),
  );
  const changed: Case[] = [];
  let used = 0;
  let noWindow = 0;
  for (const f of files) {
    const window = forced ?? windowOf(f);
    if (!window) {
      noWindow++;
      continue;
    }
    let history: Message[];
    try {
      history = modelHistoryFromScrollback((await loadSession(f)).agent);
    } catch {
      continue;
    }
    if (!history.some(m => m.role === 'tool')) continue;
    used++;
    const res = replay(history, window, cwdOf(f));
    for (const [arm, turns] of res) {
      const t = totals.get(arm)!;
      for (const r of turns) {
        t.turns++;
        if (r.ledger) t.ledger++;
        if (r.withdrawn) t.withdrawn++;
        if (r.withdrawn && r.editedAfter) t.edited++;
      }
    }
    const a = res.get('stack-all')!;
    const b = res.get('skip-removed')!;
    a.forEach((r, n) => {
      if (r.withdrawn === b[n].withdrawn) return;
      changed.push({
        file: f.replace(homedir(), '~'),
        turn: n,
        round: (r.withdrawn ? r.firstWithdrawRound : b[n].firstWithdrawRound) ?? -1,
        withdrawnIn: r.withdrawn ? ['stack-all'] : ['skip-removed'],
        editedAfter: r.editedAfter,
      });
    });
  }
  console.log(
    `${used} sessions replayed (${noWindow} skipped: no window)${forced ? `, window forced to ${forced}` : ''}`,
  );
  for (const [arm, t] of totals) {
    console.log(
      `arm=${arm} turns=${t.turns} ledger-turns=${t.ledger} withdrawn-turns=${t.withdrawn}` +
        ` withdrawn-then-edited=${t.edited}`,
    );
  }
  const lost = changed.filter(c => c.withdrawnIn[0] === 'stack-all');
  const gained = changed.filter(c => c.withdrawnIn[0] === 'skip-removed');
  console.log(
    `withdrawals removed: ${lost.length}` +
      ` (session went on to edit in ${lost.filter(c => c.editedAfter).length}); added: ${gained.length}`,
  );
  if (list)
    for (const c of changed)
      console.log(`  ${c.withdrawnIn[0]} turn=${c.turn} round=${c.round} ${c.file}`);
}

void main();
