import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool, ToolContext } from '../types.js';

// The loop hands every tool the names of the turn's tool list (#377): a tool result must not
// point the model at a tool it does not have, and the tool cannot know the list any other way.
// Driven through the real runTurn so the wiring — not just the type — is what is tested.

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
    cwd: '/tmp',
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
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

const inert = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  run: async () => ({ summary: name }),
});

describe('runTurn — ToolContext.toolNames (#377)', () => {
  it('names every tool in the turn list, and nothing else', async () => {
    const seen: (ReadonlySet<string> | undefined)[] = [];
    const probe: Tool = {
      name: 'probe',
      description: 'captures its context',
      parameters: { type: 'object', properties: {} },
      run: async (_args, ctx: ToolContext) => {
        seen.push(ctx.toolNames);
        return { summary: 'probed' };
      },
    };
    h.scripted.push({
      content: '',
      toolCalls: [{ id: 'p1', name: 'probe', args: {} }],
    });
    const history: Message[] = [];
    await runTurn({
      userInput: 'go',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [probe, inert('fetch_url'), inert('search')],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'chat',
    });
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(['fetch_url', 'probe', 'search']);
    expect(seen[0]!.has('read')).toBe(false);
  });
});
