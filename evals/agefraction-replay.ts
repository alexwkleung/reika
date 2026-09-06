#!/usr/bin/env tsx
// Counterfactual sweep of AGE_LOW_FRACTION over saved transcripts — the offline half of #253.
//
// The prefill cost of a watermark setting is a DETERMINISTIC function of a history: given the same
// messages, where shrink events fire and what each one invalidates follows from the aging rules and
// nothing else. So it does not need a model run. That matters because a live A/B cannot resolve this
// question at a sane cost: across three runs of one task at one setting, shrink events came out
// 3/4/2 and total reprocessing spanned 1.65x, while dropping the watermark to 0.5 predicts ~1.8
// events against a mean of 3 — the effect is the same size as the noise, and IQ3_XXS adds its own
// bad-run tail on top.
//
// So this replays real histories through the REAL aging code (batchAgePayloads, compactHistory,
// messagesToOpenAI, PrefixTrace — imported, never reimplemented) at each watermark, and prices the
// result with the per-token costs measured in #231 on this stack.
//
// WHAT THIS CANNOT ANSWER: the behavioural half. A lower watermark ages more payloads, the model
// re-reads more, and those re-reads change the history — feedback this replay cannot simulate,
// because it is replaying a history that already happened. Every arm here is scored on the
// conversation the 0.7 run actually had. Read it as "what would the prefill have been", never as
// "what would the run have been". The re-read term (`dup-aged`) still needs live runs.
//
// Usage:
//   npx tsx evals/agefraction-replay.ts ~/.config/reika/history/*.jsonl
//   npx tsx evals/agefraction-replay.ts --f=0.5,0.6,0.7,0.8 run.jsonl
//   npx tsx evals/agefraction-replay.ts --rate=22.9 --system=8235 run.jsonl
//
// The 0.7 arm is a CALIBRATION CHECK, not just another row: the transcripts were produced at 0.7,
// so its replayed event count and first-event cost should land near what the debug log recorded. The
// report says how close. If that arm does not reproduce, no other arm is trustworthy either.
import { readFileSync } from 'node:fs';
import type { Message, Tool } from '../src/types.js';
import { estimateRequestTokens } from '../src/provider/tokens.js';
import { messagesToOpenAI } from '../src/provider/toolcall.js';
import { PrefixTrace } from '../src/agent/prefixtrace.js';

// Per-token prices measured on the local llama.cpp stack in #231 (Qwen3.8-27B UD-IQ3_XXS, M2 16GB).
// Long-prompt prefill, NOT llama-bench's pp512 — that sample is too short to be representative.
const DEFAULT_PREFILL_TPS = 22.9;
// Attention cost of holding one context token, per generated token. #231 measures this at FULL 24k
// KV, so it is a ceiling: real cost scales with actual cache fill.
const HOLD_US_PER_CTX_TOKEN_PER_GEN_TOKEN = 3.9;
// The system block is not saved in a transcript. Its size only shifts where every arm's threshold
// sits, identically, so it cannot bias the comparison — but it does move absolute event counts,
// which is what the 0.7 calibration check exists to catch. Default is the `prompt=8235c` the debug
// log's bundle line reported for these runs.
const DEFAULT_SYSTEM_CHARS = 8235;

type Header = {
  usage?: { completionTokens?: number; contextWindow?: number };
  messageCount?: number;
};

type Arm = {
  f: number;
  events: number;
  firstEventChars: number;
  reprocessedOld: number;
  rounds: number;
  // Mean live-context tokens across requests — the retention side of the trade, and what #231's
  // hold price is charged against.
  meanLiveTokens: number;
};

function loadTranscript(path: string): { header: Header; history: Message[] } {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]) as Header;
  const history: Message[] = [];
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const role = row.role;
    // `system` rows are UI notices, never part of the model history.
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'compaction') {
      continue;
    }
    // Strip the aging state the ORIGINAL run produced — that is exactly what each arm re-derives.
    // Leaving `rendered` in would freeze the 0.7 run's capped bytes into every other arm.
    delete row.aged;
    delete row.reasoningAged;
    delete row.rendered;
    history.push(row as unknown as Message);
  }
  return { header, history };
}

// Indices of the assistant messages. Each one was produced by a request whose history is everything
// before it, so these are exactly the round boundaries.
function requestBoundaries(history: Message[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'assistant') out.push(i);
  return out;
}

async function replay(
  source: Message[],
  f: number,
  system: string,
  window: number,
  minGen: number,
): Promise<Arm> {
  // AGE_LOW_FRACTION is read once at module load, so each arm needs its own module instance. The
  // query string defeats the ESM cache; the env var is what the fresh instance reads.
  process.env.REIKA_AGE_LOW_FRACTION = String(f);
  const { batchAgePayloads, compactHistory, shouldCompact, AGE_LOW_FRACTION } = await import(
    `../src/agent/compaction.js?f=${f}`
  );
  if (Math.abs(AGE_LOW_FRACTION - f) > 1e-9) {
    throw new Error(
      `arm ${f} loaded AGE_LOW_FRACTION=${AGE_LOW_FRACTION} — module cache not busted`,
    );
  }

  // Deep copy: aging mutates the message objects, so arms must not share them.
  const src: Message[] = JSON.parse(JSON.stringify(source));
  const live: Message[] = [];
  const trace = new PrefixTrace();
  const noTools: Tool[] = [];
  const arm: Arm = {
    f,
    events: 0,
    firstEventChars: 0,
    reprocessedOld: 0,
    rounds: 0,
    meanLiveTokens: 0,
  };
  let prevTotal: number | null = null;
  let liveSum = 0;
  let cursor = 0;

  for (const boundary of requestBoundaries(src)) {
    while (cursor < boundary) live.push(src[cursor++]);
    if (live.length === 0) continue;
    const estimate = (): number =>
      estimateRequestTokens(system, live, noTools, {
        contextWindow: window,
        reasoningRounds: 1,
        minGenTokens: minGen,
        prefixStable: true,
      });

    const aged = batchAgePayloads(live, estimate, window, minGen);
    const fired = (aged as { marked: number }).marked > 0;
    if (fired) arm.events++;
    if (shouldCompact(estimate(), window, minGen)) compactHistory(live, window, 1, minGen);

    const msgs = messagesToOpenAI(system, live, {
      contextWindow: window,
      reasoningRounds: 1,
      minGenTokens: minGen,
      prefixStable: true,
      stampRenders: true,
    });
    const d = trace.record(msgs);
    arm.rounds++;
    liveSum += estimate();

    // Same split the log-side report uses: what diverged, minus what was new, is what an earlier
    // rewrite forced through the engine a second time.
    const diverged = d.totalChars - d.stableChars;
    const growth = prevTotal == null ? diverged : d.totalChars - prevTotal;
    const old = prevTotal == null ? 0 : Math.max(diverged - growth, 0);
    prevTotal = d.totalChars;
    if (fired) {
      arm.reprocessedOld += old;
      if (arm.firstEventChars === 0) arm.firstEventChars = old;
    }
  }
  arm.meanLiveTokens = arm.rounds > 0 ? liveSum / arm.rounds : 0;
  return arm;
}

function fmtMin(seconds: number): string {
  return seconds >= 90 ? `${(seconds / 60).toFixed(1)}m` : `${Math.round(seconds)}s`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  const fractions = (flag('f') ?? '0.5,0.6,0.7,0.8').split(',').map(Number);
  const rate = Number(flag('rate') ?? DEFAULT_PREFILL_TPS);
  const systemChars = Number(flag('system') ?? DEFAULT_SYSTEM_CHARS);
  const paths = args.filter(a => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error(
      'usage: npx tsx evals/agefraction-replay.ts [--f=0.5,0.7] <transcript.jsonl ...>',
    );
    process.exit(1);
  }
  const system = 'S'.repeat(systemChars);

  for (const path of paths) {
    const { header, history } = loadTranscript(path);
    const window = header.usage?.contextWindow;
    if (!window) {
      console.log(`\n=== ${path.split('/').pop()} === no contextWindow in header, skipping`);
      continue;
    }
    // The generation reserve is not recorded in a transcript; these runs used 6144.
    const minGen = Number(flag('mingen') ?? 6144);
    const generated = header.usage?.completionTokens ?? 0;

    console.log(`\n=== ${path.split('/').pop()} ===`);
    console.log(
      `  window=${window} minGen=${minGen} messages=${history.length} generated=${generated}tok`,
    );
    console.log('     f  events  first-event  reprocessed-old   prefill   hold(attn)     total');

    const arms: Arm[] = [];
    for (const f of fractions) arms.push(await replay(history, f, system, window, minGen));

    for (const a of arms) {
      // #231's two prices. Prefill: the tokens an event forced back through the engine. Hold: the
      // attention cost of carrying a larger live context through every generated token.
      const prefillSec = a.reprocessedOld / 4 / rate;
      const holdSec = (a.meanLiveTokens * HOLD_US_PER_CTX_TOKEN_PER_GEN_TOKEN * generated) / 1e6;
      const mark = Math.abs(a.f - 0.7) < 1e-9 ? ' <- calibration' : '';
      console.log(
        `  ${a.f.toFixed(2)}  ${String(a.events).padStart(6)}  ` +
          `${String(a.firstEventChars).padStart(11)}  ${String(a.reprocessedOld).padStart(15)}  ` +
          `${fmtMin(prefillSec).padStart(8)}  ${fmtMin(holdSec).padStart(11)}  ` +
          `${fmtMin(prefillSec + holdSec).padStart(8)}${mark}`,
      );
    }
    const base = arms.find(a => Math.abs(a.f - 0.7) < 1e-9);
    if (base) {
      console.log(
        `  calibration: the 0.7 arm replays ${base.events} events, first costing ${base.firstEventChars}c —` +
          ` compare against this run's debug log before trusting the other arms.`,
      );
    }
  }
  console.log(
    '\n  Prefill and hold only. A lower watermark ages more payloads and provokes more re-reads,\n' +
      '  which this replay cannot simulate — that term needs live runs (`dup-aged`).\n',
  );
}

void main();
