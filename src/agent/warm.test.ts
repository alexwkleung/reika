import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { messagesToOpenAI } from '../provider/toolcall.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import type { PromptMode } from './prompt.js';

// Mock the client so runTurn's round-0 request is captured instead of sent; the warmer under
// test shares the same mock. The history is snapshotted at call time — runTurn keeps mutating
// the same array after the call (it pushes the final assistant reply), so inspecting
// mock.calls after the turn would see messages the request never contained.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as { system: string; history: Message[] }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { system: string; history: Message[] }) => {
    h.captured.push({ system: opts.system, history: opts.history.slice() });
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');
const { buildWarmPayload, createPrefixWarmer, shouldSkipWarm, warmKey } = await import('./warm.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: 'proj',
    repoMap: 'map',
    instructions: '',
    cwd: tmpdir(),
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
    ...overrides,
  };
}

// A prior completed turn: request, one read round, final answer.
function priorTurn(): Message[] {
  return [
    { role: 'user', content: 'look at a.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: 'const a = 1;'.repeat(10) },
    { role: 'assistant', content: 'a.ts defines a.' },
  ];
}

const serializeOpts = (config: Config) => ({
  contextWindow: config.contextWindow,
  calibration: 1,
  reasoningRounds: config.reasoningRounds,
  minGenTokens: config.minGenTokens,
});

// Capture the {system, history} runTurn's round 0 actually dispatches for this history/mode.
async function captureRoundZero(
  history: Message[],
  promptMode: PromptMode,
  config: Config,
): Promise<{ system: string; history: Message[] }> {
  h.scripted.push({ content: 'final', toolCalls: undefined });
  await runTurn({
    userInput: 'do the thing',
    history,
    bundle: makeBundle(),
    config,
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    promptMode,
  });
  return h.captured[0];
}

describe('buildWarmPayload drift (warm prefix must match the real round-0 request)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
    vi.mocked(callModel).mockClear();
  });

  for (const promptMode of ['agent', 'plan', 'chat'] as const) {
    it(`serializes as a strict message prefix of the real request (${promptMode} mode)`, async () => {
      const config = makeConfig();
      const preTurn = priorTurn();
      const warm = buildWarmPayload({
        history: preTurn,
        bundle: makeBundle(),
        config,
        tools: [],
        promptMode,
        calibration: 1,
      });
      const real = await captureRoundZero(preTurn.slice(), promptMode, config);

      expect(warm.system).toBe(real.system);
      const warmMsgs = messagesToOpenAI(warm.system, warm.history, serializeOpts(config));
      const realMsgs = messagesToOpenAI(real.system, real.history, serializeOpts(config));
      // Real request = warm request + exactly the trailing user message.
      expect(realMsgs.length).toBe(warmMsgs.length + 1);
      expect(realMsgs.slice(0, warmMsgs.length)).toEqual(warmMsgs);
      expect(realMsgs[realMsgs.length - 1]).toMatchObject({
        role: 'user',
        content: 'do the thing',
      });
    });
  }

  it('empty history: warms the system prompt (divergence starts at the user turn)', async () => {
    const config = makeConfig();
    const warm = buildWarmPayload({
      history: [],
      bundle: makeBundle(),
      config,
      tools: [],
      promptMode: 'agent',
      calibration: 1,
    });
    const real = await captureRoundZero([], 'agent', config);
    const warmMsgs = messagesToOpenAI(warm.system, warm.history, serializeOpts(config));
    const realMsgs = messagesToOpenAI(real.system, real.history, serializeOpts(config));
    // The warm gets the `(continue)` backstop as its user turn; the real request has the typed
    // one. The system block — the whole payload at session start — is identical.
    expect(warmMsgs[0]).toEqual(realMsgs[0]);
    expect(warmMsgs[0].role).toBe('system');
  });

  it('never mutates the caller history', () => {
    const history = priorTurn();
    const before = structuredClone(history);
    buildWarmPayload({
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      promptMode: 'agent',
      calibration: 1,
    });
    expect(history).toEqual(before);
  });
});

describe('warmKey', () => {
  const ctx = () => ({
    history: priorTurn(),
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    promptMode: 'agent' as const,
    calibration: 1,
  });

  it('is stable for the same inputs', () => {
    expect(warmKey(ctx())).toBe(warmKey(ctx()));
  });

  it('changes with mode, model, bundle, history length, and last-message shape', () => {
    const base = warmKey(ctx());
    expect(warmKey({ ...ctx(), promptMode: 'plan' })).not.toBe(base);
    expect(warmKey({ ...ctx(), config: makeConfig({ model: 'other' }) })).not.toBe(base);
    expect(warmKey({ ...ctx(), bundle: { ...makeBundle(), hash: 'other' } })).not.toBe(base);
    expect(warmKey({ ...ctx(), history: ctx().history.slice(0, -1) })).not.toBe(base);
    const swapped = ctx().history;
    swapped[swapped.length - 1] = { role: 'assistant', content: 'a different final answer' };
    expect(warmKey({ ...ctx(), history: swapped })).not.toBe(base);
  });
});

describe('shouldSkipWarm', () => {
  const ctxWith = (config: Config) => ({
    history: priorTurn(),
    bundle: makeBundle(),
    config,
    tools: [],
    promptMode: 'agent' as const,
    calibration: 1,
  });

  it('skips when the submit would land in compaction range', () => {
    const config = makeConfig({ contextWindow: 640, minGenTokens: 512 });
    const ctx = ctxWith(config);
    const { system, history } = buildWarmPayload(ctx);
    expect(shouldSkipWarm(ctx, system, history)).toBe('near-compaction');
  });

  it('allows warming with a roomy window', () => {
    const ctx = ctxWith(makeConfig({ contextWindow: 200000 }));
    const { system, history } = buildWarmPayload(ctx);
    expect(shouldSkipWarm(ctx, system, history)).toBeNull();
  });

  it('allows warming when the window is unknown (no compaction ever fires)', () => {
    const ctx = ctxWith(makeConfig({ contextWindow: undefined }));
    const { system, history } = buildWarmPayload(ctx);
    expect(shouldSkipWarm(ctx, system, history)).toBeNull();
  });
});

describe('createPrefixWarmer', () => {
  const PRIOR = process.env.REIKA_WARM;
  beforeEach(() => {
    process.env.REIKA_WARM = '1';
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
    vi.mocked(callModel).mockImplementation(
      async () => h.scripted.shift() ?? { content: '', toolCalls: undefined },
    );
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.REIKA_WARM;
    else process.env.REIKA_WARM = PRIOR;
  });

  const ctx = () => ({
    history: priorTurn(),
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    promptMode: 'agent' as const,
    calibration: 1,
  });

  const tick = () => new Promise(r => setImmediate(r));

  it('is a no-op with the flag off', () => {
    delete process.env.REIKA_WARM;
    createPrefixWarmer().onEdge(ctx());
    expect(callModel).not.toHaveBeenCalled();
  });

  it('fires a 1-token request and dedupes repeat edges on the same prefix', async () => {
    const warmer = createPrefixWarmer();
    warmer.onEdge(ctx());
    warmer.onEdge(ctx()); // same key, in flight → skipped
    await tick();
    warmer.onEdge(ctx()); // same key, completed → skipped
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callModel).mock.calls[0][0].maxTokens).toBe(1);
  });

  it('re-warms when the prefix identity changes', async () => {
    const warmer = createPrefixWarmer();
    warmer.onEdge(ctx());
    await tick();
    warmer.onEdge({ ...ctx(), promptMode: 'plan' });
    await tick();
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('cancel aborts the in-flight request', async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(callModel).mockImplementation(
      opts =>
        new Promise(resolve => {
          seen = opts.signal;
          opts.signal?.addEventListener('abort', () => resolve({ content: '' }));
        }),
    );
    const warmer = createPrefixWarmer();
    warmer.onEdge(ctx());
    warmer.cancel('submit');
    await tick();
    expect(seen?.aborted).toBe(true);
  });

  it('swallows a failed warm and retries on the next edge', async () => {
    vi.mocked(callModel).mockRejectedValueOnce(new Error('server down'));
    const warmer = createPrefixWarmer();
    expect(() => warmer.onEdge(ctx())).not.toThrow();
    await tick();
    warmer.onEdge(ctx()); // failure did not latch completedKey → retried
    await tick();
    expect(callModel).toHaveBeenCalledTimes(2);
  });
});
