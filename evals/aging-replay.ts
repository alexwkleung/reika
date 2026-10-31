// Prices a change to what a shrink event sheds — sweep order, size floors, a new sweep — before
// any model run. Each saved session's model history is re-grown one request at a time at a fixed
// window through the loop's own batchAgePayloads + compactHistory, once per arm. The transcript's
// later calls are fixed, so "re-read" below is a proxy: a shed read whose region the session reads
// again afterwards. The arm here is #821's superseded-read sweep (measured null: <1% of shed);
// a new candidate is another `Arm` beside it.
//
//   pnpm exec tsx evals/aging-replay.ts [--window=24000,32000] [dir-or-file ...]
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGE_LOW_FRACTION,
  batchAgePayloads,
  compactHistory,
  compactThreshold,
  shouldCompact,
} from '../src/agent/compaction.js';
import { findFreshToolBlockStart, taskSpecIndex } from '../src/provider/toolcall.js';
import { estimateRequestTokens } from '../src/provider/tokens.js';
import { loadSession, modelHistoryFromScrollback } from '../src/store/sessions.js';
import type { Message } from '../src/types.js';

const MIN_GEN = 2048;
// Stand-in for the system prompt + tool definitions, which the transcript does not carry.
const SYSTEM = 'x'.repeat(14000);
const READ_RE = /^Read (\S+) lines (\d+)-(\d+) of \d+/;

type ReadInfo = { path: string; from: number; to: number; capped: boolean };
type Arm = 'today' | 'superseded-first';
type Stats = {
  requests: number;
  events: number;
  folds: number;
  shedChars: number;
  supersededAvail: number;
  supersededShed: number;
  shedThenReread: number;
  shedThenRereadChars: number;
};

const readInfo = new WeakMap<Message, ReadInfo>();

function protectedTailStart(history: Message[]): number {
  let i = findFreshToolBlockStart(history) - 1;
  while (i >= 0 && history[i].role !== 'assistant') i--;
  return i >= 0 ? i : 0;
}

function isAgedTool(m: Message): boolean {
  return m.role === 'tool' && !!m.aged;
}

function payloadChars(m: Message): number {
  return m.role === 'tool' && m.payload ? m.payload.length : 0;
}

function supersededIndices(history: Message[], protect: number, specIdx: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < protect; i++) {
    if (i === specIdx) continue;
    const m = history[i];
    const r = readInfo.get(m);
    if (!r || m.role !== 'tool' || m.aged || !m.payload) continue;
    for (let j = i + 1; j < history.length; j++) {
      const n = history[j];
      const s = readInfo.get(n);
      if (!s || n.role !== 'tool' || n.aged || !n.payload || s.capped) continue;
      if (s.path === r.path && s.from <= r.from && s.to >= r.to) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

function rereadLater(all: Message[], from: number, r: ReadInfo): boolean {
  for (let k = from; k < all.length; k++) {
    const s = readInfo.get(all[k]);
    if (s && s.path === r.path && s.from <= r.to && s.to >= r.from) return true;
  }
  return false;
}

function replay(source: Message[], window: number, arm: Arm): Stats {
  const all = source.map(m => {
    const c = { ...m } as Message;
    if (c.role === 'assistant') delete c.reasoningAged;
    if (c.role === 'tool') {
      const saved = c.rendered;
      delete c.aged;
      delete c.rendered;
      const hit = READ_RE.exec(c.summary ?? '');
      if (hit) {
        // A saved frozen render shorter than the full body means the fit-to-window cap cut it in
        // the real session — the one signal of capping the transcript keeps.
        const full = `${c.summary}\n\n${c.payload ?? ''}`;
        const capped = saved !== undefined && saved.length < full.length - 1;
        readInfo.set(c, { path: hit[1], from: Number(hit[2]), to: Number(hit[3]), capped });
      }
    }
    return c;
  });
  const st: Stats = {
    requests: 0,
    events: 0,
    folds: 0,
    shedChars: 0,
    supersededAvail: 0,
    supersededShed: 0,
    shedThenReread: 0,
    shedThenRereadChars: 0,
  };
  const live: Message[] = [];
  const estimate = () =>
    estimateRequestTokens(SYSTEM, live, [], {
      contextWindow: window,
      minGenTokens: MIN_GEN,
      prefixStable: true,
    });
  const threshold = compactThreshold(window, MIN_GEN);
  const target = threshold * AGE_LOW_FRACTION;
  for (let i = 0; i < all.length; i++) {
    if (all[i].role === 'assistant' && live.length > 0) {
      st.requests++;
      if (estimate() > threshold) {
        const protect = protectedTailStart(live);
        const specIdx = taskSpecIndex(live);
        const sup = supersededIndices(live, protect, specIdx);
        st.supersededAvail += sup.reduce((n, k) => n + payloadChars(live[k]), 0);
        const before = new Set(live.filter(isAgedTool));
        let marked = 0;
        if (arm === 'superseded-first') {
          for (const k of sup) {
            if (estimate() <= target) break;
            const m = live[k];
            if (m.role === 'tool') m.aged = true;
            st.supersededShed += payloadChars(live[k]);
            marked++;
          }
        }
        const res = batchAgePayloads(live, estimate, window, MIN_GEN);
        marked += res.marked;
        const supSet = new Set(sup.map(k => live[k]));
        for (const m of live) {
          if (!isAgedTool(m) || before.has(m)) continue;
          st.shedChars += payloadChars(m);
          if (arm === 'today' && supSet.has(m)) st.supersededShed += payloadChars(m);
          const r = readInfo.get(m);
          if (r && rereadLater(all, i, r)) {
            st.shedThenReread++;
            st.shedThenRereadChars += payloadChars(m);
          }
        }
        const agedAbove = marked > 0 && estimate() > target;
        if (marked > 0) st.events++;
        if (shouldCompact(estimate(), window, MIN_GEN) || agedAbove) {
          if (compactHistory(live, window, 1, MIN_GEN) > 0) {
            st.folds++;
            if (marked === 0) st.events++;
          }
        }
      }
    }
    live.push(all[i]);
  }
  return st;
}

function sessionFiles(args: string[]): string[] {
  const roots = args.length ? args : [join(homedir(), '.config/reika/history/projects')];
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
  const windows = (winArg ? winArg.slice(9) : '24000,32000').split(',').map(Number);
  const files = sessionFiles(argv.filter(a => !a.startsWith('--')));
  const sessions: Message[][] = [];
  for (const f of files) {
    try {
      const h = modelHistoryFromScrollback((await loadSession(f)).agent);
      if (h.some(m => readInfo.has(m) || (m.role === 'tool' && READ_RE.test(m.summary ?? ''))))
        sessions.push(h);
    } catch {
      // A truncated or foreign file is not a session worth failing the run over.
    }
  }
  console.log(`${sessions.length} sessions with reads (of ${files.length} files)`);
  for (const w of windows) {
    for (const arm of ['today', 'superseded-first'] as Arm[]) {
      const tot: Stats = {
        requests: 0,
        events: 0,
        folds: 0,
        shedChars: 0,
        supersededAvail: 0,
        supersededShed: 0,
        shedThenReread: 0,
        shedThenRereadChars: 0,
      };
      let withSup = 0;
      let withEvents = 0;
      for (const s of sessions) {
        const st = replay(s, w, arm);
        if (st.events > 0) withEvents++;
        if (st.supersededAvail > 0) withSup++;
        for (const k of Object.keys(tot) as (keyof Stats)[]) tot[k] += st[k];
      }
      const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
      console.log(
        `window=${w} arm=${arm} sessions-with-events=${withEvents} sessions-with-superseded=${withSup}` +
          ` requests=${tot.requests} events=${tot.events} folds=${tot.folds}` +
          ` shed=${tot.shedChars}c superseded-avail=${tot.supersededAvail}c` +
          ` superseded-shed=${tot.supersededShed}c (${pct(tot.supersededShed, tot.shedChars)} of shed)` +
          ` shed-then-reread=${tot.shedThenReread} (${tot.shedThenRereadChars}c)`,
      );
    }
  }
}

void main();
