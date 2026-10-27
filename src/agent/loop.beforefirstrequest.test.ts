import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// The order a turn runs in when something must settle before it sends anything (#827's probe):
// the user's message is emitted first, so it is on screen during the wait, and no request goes out
// until the wait is over.
const h = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (): Promise<ModelResponse> => {
    h.events.push('request');
    return { content: 'done', toolCalls: undefined };
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

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 3,
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

describe('beforeFirstRequest', () => {
  it('runs after the user message is emitted and before the first request', async () => {
    h.events.length = 0;
    const history: Message[] = [];
    await runTurn({
      userInput: 'fix the bug',
      history,
      bundle,
      config,
      tools: [],
      payloads: new PayloadStore(),
      onMessage: m => {
        if (m.role === 'user') h.events.push('user');
      },
      beforeFirstRequest: async () => {
        h.events.push('wait-start');
        await new Promise(r => setTimeout(r, 10));
        h.events.push('wait-end');
      },
    });
    expect(h.events).toEqual(['user', 'wait-start', 'wait-end', 'request']);
  });
});
