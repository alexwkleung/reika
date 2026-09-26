import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { GenReserve } from './genreserve.js';

// The learned reserve (#551) has to reach every request of the turn it was learned in — a long
// single turn is where folds happen — and carry into the next turn through the session's learner.
const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[], sent: [] as number[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { config: Config }) => {
    h.sent.push(opts.config.minGenTokens);
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined, finishReason: 'stop' };
  }),
}));

const { runTurn } = await import('./loop.js');

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
  hash: 'test',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

function makeConfig(minGenAdaptive?: boolean): Config {
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
    contextWindow: 64_000,
    minGenTokens: 2048,
    minGenAdaptive,
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

// A thinking round that generated 5000 tokens before its call: 5000 × 1.25 → 6400.
const bigRound: ModelResponse = {
  content: '',
  toolCalls: [{ id: 'n1', name: 'noop', args: {} }],
  finishReason: 'tool_calls',
  usage: { promptTokens: 3000, completionTokens: 5000 },
};

async function turn(config: Config, genReserve?: GenReserve): Promise<void> {
  const history: Message[] = [];
  await runTurn({
    userInput: 'go',
    history,
    bundle,
    config,
    tools: [noopTool],
    payloads: new PayloadStore(),
    onMessage: () => {},
    genReserve,
  });
}

describe('learned generation reserve (integration)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.sent.length = 0;
  });

  it('raises the reserve for the next round of the same turn', async () => {
    h.scripted.push(bigRound);
    await turn(makeConfig(true));
    expect(h.sent).toEqual([2048, 6400]);
  });

  it('carries into the next turn through the shared learner', async () => {
    const reserve = new GenReserve();
    h.scripted.push(bigRound);
    await turn(makeConfig(true), reserve);
    h.sent.length = 0;
    await turn(makeConfig(true), reserve);
    expect(h.sent).toEqual([6400]);
  });

  it('learns nothing from a round cut at the limit', async () => {
    h.scripted.push({ ...bigRound, finishReason: 'length' });
    await turn(makeConfig(true));
    expect(h.sent.every(t => t === 2048)).toBe(true);
  });

  it('a pinned reserve never moves', async () => {
    h.scripted.push(bigRound);
    await turn(makeConfig());
    expect(h.sent).toEqual([2048, 2048]);
  });
});
