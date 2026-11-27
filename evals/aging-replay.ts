// Prices a change to what a shrink event sheds — sweep order, size floors, a new sweep — before
// any model run. Each saved session's model history is re-grown one request at a time at a fixed
// window through the loop's own batchAgePayloads + compactHistory, once per arm. The transcript's
// later calls are fixed, so "re-read" below is a proxy: a shed read whose region the session reads
// again afterwards. Arms: #821's superseded-read sweep (measured null: <1% of shed), and
// `protect-N`, which keeps the reads of the last N rounds before the active one out of a shed.
// `no-args`, `oracle:F` and `recent:F` are described at `Arm`; the oracle is the ceiling for any
// rule that keeps shed regions, and at best broke even against the folds it added.
// Each request marks the payloads it carried as sent, as the real call path does: unmarked, the
// estimate prices a payload at the cap's room and sheds too late. REIKA_AGE_LOW_FRACTION sweeps the
// shed depth (one process per value), and REPLAY_CALIBRATION the char/token factor (default 1.15).
//
//   pnpm exec tsx evals/aging-replay.ts [--window=24000,32000] [--arms=today,no-args,protect-2,oracle:0.05] [dir-or-file ...]
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
import { parseBashFileRead } from '../src/agent/bashread.js';
import { AGE_CALL_ARGS, findFreshToolBlockStart, taskSpecIndex } from '../src/provider/toolcall.js';
import { estimateRequestTokens } from '../src/provider/tokens.js';
import { loadSession, modelHistoryFromScrollback } from '../src/store/sessions.js';
import type { Message } from '../src/types.js';

const MIN_GEN = 2048;
// Stand-in for the system prompt + tool definitions, which the transcript does not carry.
const SYSTEM = 'x'.repeat(14000);
const READ_RE = /^Read (\S+) lines (\d+)-(\d+) of \d+/;

type ReadInfo = { path: string; from: number; to: number; capped: boolean };
// `no-args`: batch aging without stubbing old call arguments (REIKA_AGE_ARGS=0, #1126); every
// other arm runs it as shipped (on unless REIKA_AGE_ARGS=0). `oracle:F` / `recent:F` keep a view of shed read regions,
// refreshed at each shrink event and sized to F of the window: the oracle keeps the regions the
// session reads again soonest (Belady, the ceiling for any retention rule), `recent` the most
// recently read ones. A later read the view covers is served from it and enters history aged.
type Arm = string;
type Region = { path: string; from: number; to: number; text: string };
const CALIBRATION = Number(process.env.REPLAY_CALIBRATION ?? 1.15);
type Stats = {
  requests: number;
  events: number;
  folds: number;
  shedChars: number;
  shedReasoningChars: number;
  supersededAvail: number;
  supersededShed: number;
  shedThenReread: number;
  shedThenRereadChars: number;
  // A read of a region seen before whose bytes no live copy covers: the re-read aging caused.
  forced: number;
  served: number;
  viewChars: number;
};

const readInfo = new WeakMap<Message, ReadInfo>();

function protectedTailStart(history: Message[]): number {
  let i = findFreshToolBlockStart(history) - 1;
  while (i >= 0 && history[i].role !== 'assistant') i--;
  return i >= 0 ? i : 0;
}

// Index of the assistant message that opened the round `rounds` before the active one, so a shed
// leaves that round and every later one alone; Infinity (no extra protection) for 0.
function recentRoundsStart(history: Message[], rounds: number): number {
  if (rounds <= 0) return Infinity;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    if (seen++ === rounds) return i;
  }
  return 0;
}

function covers(v: { path: string; from: number; to: number }, r: ReadInfo): boolean {
  return v.path === r.path && v.from <= r.from && v.to >= r.to;
}

function liveCovers(live: Message[], r: ReadInfo): boolean {
  return live.some(m => {
    const s = readInfo.get(m);
    return m.role === 'tool' && !m.aged && !!m.payload && !!s && covers(s, r);
  });
}

function isGone(all: Message[], i: number, live: Message[], r: ReadInfo): boolean {
  for (let k = 0; k < i; k++) {
    const s = readInfo.get(all[k]);
    if (s && covers(s, r)) return !liveCovers(live, r);
  }
  return false;
}

function nextUse(all: Message[], from: number, r: ReadInfo): number {
  for (let k = from; k < all.length; k++) {
    const s = readInfo.get(all[k]);
    if (s && s.path === r.path && s.from <= r.to && s.to >= r.from) return k;
  }
  return Infinity;
}

function buildView(
  all: Message[],
  i: number,
  live: Message[],
  kind: string,
  budget: number,
): Region[] {
  const cands: Array<{ r: ReadInfo; text: string; at: number }> = [];
  for (let k = i - 1; k >= 0; k--) {
    const m = all[k];
    const r = readInfo.get(m);
    if (m.role !== 'tool' || !r || !m.payload || r.capped) continue;
    if (cands.some(c => covers(c.r, r)) || liveCovers(live, r)) continue;
    cands.push({ r, text: m.payload, at: k });
  }
  const ranked = cands
    .map(c => ({ c, k: kind === 'oracle' ? nextUse(all, i, c.r) : -c.at }))
    .filter(x => x.k !== Infinity)
    .sort((a, b) => a.k - b.k);
  const out: Region[] = [];
  let used = 0;
  for (const { c } of ranked) {
    if (used + c.text.length > budget) continue;
    used += c.text.length;
    out.push({ ...c.r, text: c.text });
  }
  return out;
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
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of source)
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.set(c.id, c);
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
      } else {
        // A one-file shell read is a read too: a model that reads through the shell re-reads that way.
        const call = calls.get(c.callId);
        const b =
          call?.name === 'bash' && c.summary.startsWith('Ran: ')
            ? parseBashFileRead(String(call.args.command ?? ''))
            : undefined;
        if (b && 'from' in b.range) {
          const to = b.range.count === undefined ? Infinity : b.range.from + b.range.count - 1;
          readInfo.set(c, {
            path: b.path.replace(/^\.\//, ''),
            from: b.range.from,
            to,
            capped: false,
          });
        }
      }
    }
    return c;
  });
  const st: Stats = {
    requests: 0,
    events: 0,
    folds: 0,
    shedChars: 0,
    shedReasoningChars: 0,
    supersededAvail: 0,
    supersededShed: 0,
    shedThenReread: 0,
    shedThenRereadChars: 0,
    forced: 0,
    served: 0,
    viewChars: 0,
  };
  const live: Message[] = [];
  const [viewKind, viewFrac] = arm.includes(':')
    ? [arm.split(':')[0], Number(arm.split(':')[1])]
    : ['', 0];
  // char/4, the estimate's own baseline density.
  const viewBudget = viewFrac * window * 4;
  let view: Region[] = [];
  let viewText = '';
  const estimate = () =>
    CALIBRATION *
    estimateRequestTokens(SYSTEM + viewText, live, [], {
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
        const reasonedBefore = new Set(live.filter(m => m.role === 'assistant' && m.reasoningAged));
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
        const keep = arm.startsWith('protect-') ? Number(arm.slice(8)) : 0;
        const res = batchAgePayloads(
          live,
          estimate,
          window,
          MIN_GEN,
          true,
          arm === 'no-args' ? false : AGE_CALL_ARGS,
          recentRoundsStart(live, keep),
        );
        marked += res.marked;
        for (const m of live)
          if (m.role === 'assistant' && m.reasoningAged && m.reasoning && !reasonedBefore.has(m))
            st.shedReasoningChars += m.reasoning.length;
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
          // The view is in the estimate, so the fold is sized with its tokens off the window.
          if (compactHistory(live, window - Math.ceil(viewText.length / 4), 1, MIN_GEN) > 0) {
            st.folds++;
            if (marked === 0) st.events++;
          }
        }
        if (viewKind) {
          view = buildView(all, i, live, viewKind, viewBudget);
          viewText = view.map(v => v.text).join('\n');
          st.viewChars += viewText.length;
        }
      }
    }
    const r = readInfo.get(all[i]);
    const m = all[i];
    if (m.role === 'tool' && r && m.payload && isGone(all, i, live, r)) {
      st.forced++;
      if (view.some(v => covers(v, r))) {
        st.served++;
        live.push({ ...m, aged: true });
        continue;
      }
    }
    live.push(all[i]);
    // The request just answered carried every live payload, so each is now frozen at its sent bytes.
    if (all[i].role === 'assistant')
      for (const x of live)
        if (x.role === 'tool' && x.payload && !x.aged && x.rendered === undefined)
          x.rendered = `${x.summary}\n\n${x.payload}`;
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
  const armArg = argv.find(a => a.startsWith('--arms='));
  const arms = (armArg ? armArg.slice(7) : 'today,superseded-first').split(',') as Arm[];
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
    for (const arm of arms) {
      const tot: Stats = {
        requests: 0,
        events: 0,
        folds: 0,
        shedChars: 0,
        shedReasoningChars: 0,
        supersededAvail: 0,
        supersededShed: 0,
        shedThenReread: 0,
        shedThenRereadChars: 0,
        forced: 0,
        served: 0,
        viewChars: 0,
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
          ` shed-reasoning=${tot.shedReasoningChars}c shed-then-reread=${tot.shedThenReread} (${tot.shedThenRereadChars}c)` +
          ` forced-reread=${tot.forced} served=${tot.served} view-per-event=${tot.events ? Math.round(tot.viewChars / tot.events) : 0}c`,
      );
    }
  }
}

void main();
