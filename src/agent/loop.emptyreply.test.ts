import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[], calls: 0 }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => {
    h.calls++;
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

const EMPTY: ModelResponse = { content: '', reasoning: 'thinking', finishReason: 'stop' };

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

async function run(): Promise<{ history: Message[]; emitted: Message[] }> {
  const history: Message[] = [];
  const emitted: Message[] = [];
  await runTurn({
    userInput: 'do the task',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    payloads: new PayloadStore(),
    onMessage: m => emitted.push(m),
    promptMode: 'agent',
  });
  return { history, emitted };
}

const warnings = (emitted: Message[]): string[] =>
  emitted.flatMap(m => (m.role === 'system' && m.tone === 'warn' ? [m.content] : []));

describe('a reply with no text and no call', () => {
  beforeEach(() => {
    h.scripted = [];
    h.calls = 0;
  });

  it('is asked to continue once, without starting a turn', async () => {
    h.scripted = [EMPTY, { content: 'the answer', finishReason: 'stop' }];
    const { history, emitted } = await run();
    expect(h.calls).toBe(2);
    expect(history.filter(m => m.role === 'user' && m.harness)).toHaveLength(1);
    expect(warnings(emitted)).toEqual([
      'The model stopped without replying — asking it to continue.',
    ]);
  });

  it('stops on a second empty reply and says so', async () => {
    h.scripted = [EMPTY, EMPTY];
    const { emitted } = await run();
    expect(h.calls).toBe(2);
    expect(warnings(emitted).at(-1)).toContain('Send a prompt to continue');
  });

  it('leaves a turn that answered alone', async () => {
    h.scripted = [{ content: 'the answer', finishReason: 'stop' }];
    const { emitted } = await run();
    expect(h.calls).toBe(1);
    expect(warnings(emitted)).toEqual([]);
  });
});
