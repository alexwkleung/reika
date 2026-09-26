import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import { subagentTool } from '../tools/subagent.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The debug line quotes the round's sample, so this test needs the log turned on before loop.ts
// (and its `debugEnabled()` latch) is loaded — same harness shape as loop.prefill.test.ts.
const PRIOR_DEBUG = process.env.REIKA_DEBUG;
const PRIOR_FILE = process.env.REIKA_DEBUG_FILE;
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('REIKA_DEBUG', PRIOR_DEBUG);
  restore('REIKA_DEBUG_FILE', PRIOR_FILE);
});

// Wiring for the status bar's tok/s chip (issue #204): the loop has to hand the UI a rate derived
// from the round it just finished, and has to stay silent on rounds too short to measure one.
const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd: tmpdir(),
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 10,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

const noopTool: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

const callNoop = { id: 'n1', name: 'noop', args: {} };
// 600 tokens streamed over 30 s of decode behind a 10 s prefill: 20 tok/s.
const fullRound: ModelResponse = {
  content: 'done',
  toolCalls: undefined,
  usage: { promptTokens: 5000, completionTokens: 600 },
  timing: { ttftMs: 10_000, totalMs: 40_000 },
};

describe('decode rate reporting (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    h.scripted.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'reika-decode-'));
    process.env.REIKA_DEBUG_FILE = join(dir, 'debug.log');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(priorDecodeRate?: number): Promise<(number | undefined)[]> {
    const seen: (number | undefined)[] = [];
    const history: Message[] = [];
    await runTurn({
      userInput: 'go',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      onDecodeRate: r => seen.push(r),
      ...(priorDecodeRate != null ? { priorDecodeRate } : {}),
    });
    return seen;
  }

  it('reports the rate of the round that just decoded', async () => {
    h.scripted.push(fullRound);
    expect(await run()).toEqual([20]);
  });

  it('reports nothing for a call that never streamed a token', async () => {
    h.scripted.push({ ...fullRound, timing: undefined });
    expect(await run()).toEqual([]);
  });

  // A 8-token tool call over 50 ms is the engine's chunking, not its throughput — the chip keeps
  // showing the last rate that meant something rather than flashing a bogus one.
  it('stays silent on a round too small to measure', async () => {
    h.scripted.push(
      // Round 0 is measurable; round 1 (the tiny tool call) is not.
      { ...fullRound, content: '', toolCalls: [callNoop] },
      {
        content: 'done',
        toolCalls: undefined,
        usage: { promptTokens: 5000, completionTokens: 8 },
        timing: { ttftMs: 5_000, totalMs: 5_050 },
      },
    );
    expect(await run()).toEqual([20]);
  });

  // Threaded across turns like the other learners: a turn's first round must not start blank, and
  // must not jump to its own sample either — the same 0.3 EMA the module documents.
  it('smooths the new sample over the rate carried in from the prior turn', async () => {
    h.scripted.push(fullRound);
    expect(await run(10)).toEqual([13]);
  });

  // The debug line carries BOTH numbers: the round's own sample, which is the measurement, and the
  // smoothed value the chip shows, which is a fold over the session's accepted samples that nothing
  // else records. Without the pair, the displayed rate is the one number in the UI that cannot be
  // checked against a run.
  it('quotes the round sample and the value the chip shows', async () => {
    h.scripted.push(fullRound);
    await run();
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=20tok/s smoothed=20tok/s');
  });

  it('quotes both when they differ, so the chip cannot read as this round', async () => {
    h.scripted.push(fullRound);
    await run(10);
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=20tok/s smoothed=13tok/s');
  });

  // A round too small to measure leaves the chip on the last rate, and the log has to say the same:
  // `decode=?` is this round's answer, `smoothed=` is what the user is looking at.
  it('says which of the two is missing on an unmeasurable round', async () => {
    h.scripted.push(
      { ...fullRound, content: '', toolCalls: [callNoop] },
      {
        content: 'done',
        toolCalls: undefined,
        usage: { promptTokens: 5000, completionTokens: 8 },
        timing: { ttftMs: 5_000, totalMs: 5_050 },
      },
    );
    await run();
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=20tok/s smoothed=20tok/s');
    expect(log).toContain('decode=? smoothed=20tok/s');
  });

  // #536: the label on the sample is the difference between "the engine measured this" and "we
  // estimated it", and a run where the derived number sat 1.5–2.5 tok/s above the engine's own was
  // unreadable without it. `?` pairs with `decode=?`: no sample carried the round at all.
  it('names the source the round sample came from', async () => {
    h.scripted.push(fullRound);
    await run();
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=20tok/s smoothed=20tok/s src=derived');
  });

  // The same round as the engine reported it: 600 tokens over the same 30 s window derive 20 tok/s,
  // and the engine — whose quotient excludes the free first token — measured 18. Its number is the
  // one the chip shows and the one the log labels `engine`, since a local engine is where the
  // derived rate was reading high.
  it('takes the engine number over our own derivation when there is one', async () => {
    h.scripted.push({
      ...fullRound,
      engineTimings: { predictedN: 600, predictedMs: 30_000, perSecond: 18 },
    });
    expect(await run()).toEqual([18]);
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=18tok/s smoothed=18tok/s src=engine');
  });

  it('names no source on a round that offered no sample', async () => {
    h.scripted.push({ ...fullRound, timing: undefined });
    await run();
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=? smoothed=? src=?');
  });
});

// The chip sits beside the token counts, and a subagent already reports its tokens through the
// parent's onUsage — so its rate has to follow, or the two chips describe different engines.
describe('decode rate across a subagent', () => {
  const spawn: ModelResponse = {
    ...fullRound,
    content: '',
    toolCalls: [{ id: 's1', name: 'subagent', args: { task: 'look around' } }],
  };
  // 600 tokens over 10 s of decode: 60 tok/s, distinguishable from the parent's 20.
  const subReport: ModelResponse = {
    content: 'report',
    toolCalls: undefined,
    usage: { promptTokens: 3000, completionTokens: 600 },
    timing: { ttftMs: 2_000, totalMs: 12_000 },
  };

  beforeEach(() => {
    h.scripted.length = 0;
  });

  async function run(config: Config): Promise<(number | undefined)[]> {
    const seen: (number | undefined)[] = [];
    await runTurn({
      userInput: 'go',
      history: [],
      bundle: makeBundle(),
      config,
      tools: [subagentTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      onDecodeRate: r => seen.push(r),
    });
    return seen;
  }

  it('continues one learner on the same engine and hands the rate back', async () => {
    h.scripted.push(spawn, subReport, fullRound);
    const seen = await run(makeConfig());
    // parent 20 → subagent folds 60 into it (32) → parent adopts 32 and folds its 20 in (28.4).
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(20);
    expect(seen[1]).toBeCloseTo(32);
    expect(seen[2]).toBeCloseTo(28.4);
  });

  it('blanks for a subagent on another model and restores the parent rate after', async () => {
    h.scripted.push(spawn, subReport, fullRound);
    const seen = await run({ ...makeConfig(), subagentModel: 'other' });
    // The subagent's 60 is never smoothed against the parent's 20, and never carried back into it.
    expect(seen).toEqual([20, undefined, 60, 20, 20]);
  });
});
