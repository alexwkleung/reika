import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, SampledToken, Tool } from '../types.js';

// End-to-end wiring for the entropy/KL drift instrumentation (issue #134): the per-round line and
// the turn rollup have to actually reach the debug log, and the logprobs request must be gated on
// both flags. ENTROPY_LOGPROBS is read at loop.js import time, so the flags are set before the
// import; the log is pointed at a temp file per test (REIKA_DEBUG_FILE always appends, never
// truncates, so runs stay isolated by path).
const PRIOR_DEBUG = process.env.REIKA_DEBUG;
const PRIOR_FILE = process.env.REIKA_DEBUG_FILE;
const PRIOR_ENTROPY = process.env.REIKA_ENTROPY;
process.env.REIKA_DEBUG = '1';
process.env.REIKA_ENTROPY = '1';
afterAll(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('REIKA_DEBUG', PRIOR_DEBUG);
  restore('REIKA_DEBUG_FILE', PRIOR_FILE);
  restore('REIKA_ENTROPY', PRIOR_ENTROPY);
});

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  logprobs: [] as (number | undefined)[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { logprobs?: number }) => {
    h.logprobs.push(opts.logprobs);
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
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

const uniformTop = (k: number): SampledToken => ({
  token: 'x',
  logprob: Math.log(1 / k),
  top: Array.from({ length: k }, (_, i) => ({ token: `t${i}`, logprob: Math.log(1 / k) })),
});

describe('entropy/KL debug instrumentation (integration)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-entropy-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
    h.logprobs.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A do-nothing tool, so a scripted round can call it and keep the loop going for another round
  // (the drift numbers only mean anything across rounds).
  const noopTool: Tool = {
    name: 'noop',
    description: 'does nothing',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => ({ summary: 'ok' }),
  };

  async function run(): Promise<string> {
    const history: Message[] = [];
    await runTurn({
      userInput: 'do the task',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    return readFile(logPath, 'utf8');
  }

  // The `entropy round=N …` lines from a run, in order.
  const entropyLines = (log: string): string[] =>
    log.split('\n').filter(l => l.includes('] entropy round='));

  it('asks for top-k logprobs when REIKA_ENTROPY and REIKA_DEBUG are both on', async () => {
    h.scripted.push({ content: 'the answer is 42', toolCalls: undefined });
    await run();
    expect(h.logprobs).toEqual([5]);
  });

  it('logs the engine entropy and drift for a round that came back with logprobs', async () => {
    h.scripted.push({
      content: 'the answer is 42',
      reasoning: 'let me think about the arithmetic here',
      sampled: [uniformTop(4), uniformTop(4)],
      toolCalls: undefined,
    });

    const log = await run();
    const line = log.split('\n').find(l => l.includes('] entropy round='));
    expect(line).toBeDefined();
    expect(line).toContain('src=logprobs');
    expect(line).toContain(`H=${Math.log(4).toFixed(2)}n`);
    expect(line).toContain('cover=1.00');
    expect(line).toContain('positions=2');
    // First round of the turn: nothing to diverge from yet.
    expect(line).toContain('klPrev=0.00 klBase=0.00');
  });

  it('measures from text alone when the backend returned no logprobs', async () => {
    h.scripted.push({ content: 'alpha beta gamma delta', toolCalls: undefined });
    const log = await run();
    const line = log.split('\n').find(l => l.includes('] entropy round='));
    expect(line).toContain('src=text');
    expect(line).toContain('(norm 1.00)');
    expect(line).toContain('tokens=4');
  });

  it('tracks drift across the turns rounds — klPrev collapses as the model locks onto a repeat', async () => {
    const stuck = 'i should check whether the composer forwards its props correctly';
    const callNoop = { id: 'n1', name: 'noop', args: {} };
    h.scripted.push(
      { content: '', reasoning: 'first look at the router entry point', toolCalls: [callNoop] },
      { content: '', reasoning: stuck, toolCalls: [callNoop] },
      { content: stuck, toolCalls: undefined },
    );

    const lines = entropyLines(await run());
    expect(lines).toHaveLength(3);

    const kl = (line: string, key: 'klPrev' | 'klBase'): number =>
      Number(new RegExp(`${key}=([\\d.]+)`).exec(line)![1]);

    // Round 0 has no reference; round 1 moves away from it; round 2 repeats round 1 verbatim —
    // stopped moving (klPrev → 0) while still far from where the turn started (klBase high).
    expect(kl(lines[0], 'klPrev')).toBe(0);
    expect(kl(lines[1], 'klPrev')).toBeGreaterThan(0);
    expect(kl(lines[2], 'klPrev')).toBe(0);
    expect(kl(lines[2], 'klBase')).toBeGreaterThan(0);
    expect(kl(lines[2], 'klBase')).toBeCloseTo(kl(lines[1], 'klBase'), 2);
  });

  it('writes the turn rollup once the turn finishes', async () => {
    h.scripted.push({ content: 'alpha beta gamma delta', toolCalls: undefined });
    const log = await run();
    const summary = log.split('\n').find(l => l.includes('] entropy-summary '));
    expect(summary).toBeDefined();
    expect(summary).toContain('rounds=1');
    expect(summary).toContain('klPrev=n/aavg');
  });
});
