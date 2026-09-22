import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
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

  async function run(priorDecodeRate?: number): Promise<number[]> {
    const seen: number[] = [];
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
    expect(log).toContain('decode=20t/s smoothed=20t/s');
  });

  it('quotes both when they differ, so the chip cannot read as this round', async () => {
    h.scripted.push(fullRound);
    await run(10);
    const log = await readFile(join(dir, 'debug.log'), 'utf8');
    expect(log).toContain('decode=20t/s smoothed=13t/s');
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
    expect(log).toContain('decode=20t/s smoothed=20t/s');
    expect(log).toContain('decode=? smoothed=20t/s');
  });
});
