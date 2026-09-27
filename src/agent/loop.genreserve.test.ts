import { tmpdir } from 'node:os';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { GenReserve } from './genreserve.js';

// The learned reserve (#551) has to reach every request of the turn it was learned in — a long
// single turn is where folds happen — and carry into the next turn through the session's learner.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  sent: [] as number[],
  // Reasoning streamed before answering, so a test can drive the mid-stream length ceiling.
  stream: [] as string[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { config: Config; onReasoningDelta?: (t: string) => void }) => {
    h.sent.push(opts.config.minGenTokens);
    const chunk = h.stream.shift();
    if (chunk) {
      for (let i = 0; i < chunk.length; i += 1000)
        opts.onReasoningDelta?.(chunk.slice(i, i + 1000));
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined, finishReason: 'stop' };
  }),
}));

// Both are read at module load; pinned so the ceiling-cut cases don't depend on the defaults.
const PRIOR_CONTINUE = process.env.REIKA_CONTINUE;
const PRIOR_ABORT = process.env.REIKA_VERBATIM_ABORT;
process.env.REIKA_CONTINUE = '1';
process.env.REIKA_VERBATIM_ABORT = '1';
afterAll(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('REIKA_CONTINUE', PRIOR_CONTINUE);
  restore('REIKA_VERBATIM_ABORT', PRIOR_ABORT);
});

const { runTurn } = await import('./loop.js');

// Long, distinct prose past REASONING_HARD_CEIL (32000 chars): a healthy thought the ceiling cuts.
function healthy(n = 300): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `step ${i}: the line at index ${i} ends at offset ${i * 7}, so the previous line starts ` +
      `after the newline at ${i * 7 - 1} and the walk continues from there to candidate ${i + 1}`,
  ).join('\n');
}

// One sentence over and over: the ratio trips, which is a spiral, not demand.
function degenerate(n = 300): string {
  const line = 'the previous line starts at the index after the newline that terminates it';
  return Array.from({ length: n }, () => line).join('\n');
}

const cut: ModelResponse = { content: '', finishReason: 'length', toolCalls: undefined };

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
    h.stream.length = 0;
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

  // A thought the 32k-char ceiling cuts never finishes, yet on a model whose long rounds all
  // outrun the ceiling it is the only round showing real demand.
  it('learns from a healthy thought the reasoning ceiling cut', async () => {
    h.stream.push(healthy());
    h.scripted.push(cut);
    await turn(makeConfig(true));
    expect(h.sent[0]).toBe(2048);
    expect(h.sent[1]).toBeGreaterThanOrEqual(8000);
  });

  it('learns nothing from a spiral the ratio cut', async () => {
    h.stream.push(degenerate());
    h.scripted.push(cut);
    await turn(makeConfig(true));
    expect(h.sent.every(t => t === 2048)).toBe(true);
  });

  it('a pinned reserve never moves', async () => {
    h.scripted.push(bigRound);
    await turn(makeConfig());
    expect(h.sent).toEqual([2048, 2048]);
  });
});
