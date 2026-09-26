import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool, ToolContext } from '../types.js';

// #548: the exfil guard is only as good as its provenance, and provenance is whatever the loop hands
// the tool. Pinned through real dispatch, since a unit test on collectSourcedUrls stays green if the
// loop stops passing it (the guard then reads every URL as unsourced and prompts on all of them).
const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
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

describe('sourced URLs reach the tool (#548)', () => {
  it('hands a tool the URLs from user input and earlier tool results, not the model text', async () => {
    let seen: ReadonlySet<string> | undefined;
    const lookup: Tool = {
      name: 'lookup',
      description: 'returns a link',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async () => ({
        summary: 'Found 1 result',
        payload: 'See https://docs.example.com/api?version=2024-01-01T00:00',
      }),
    };
    const probe: Tool = {
      name: 'probe',
      description: 'reads provenance',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async (_args, ctx: ToolContext) => {
        seen = ctx.sourcedUrls?.();
        return { summary: 'ok' };
      },
    };
    h.scripted.push(
      {
        content: 'Next I will try https://model.example/made-up?d=abcdef1234567890',
        toolCalls: [{ id: 'a', name: 'lookup', args: {} }],
      },
      { content: '', toolCalls: [{ id: 'b', name: 'probe', args: {} }] },
    );
    const history: Message[] = [];
    await runTurn({
      userInput: 'check https://example.com/start?ref=abcdefghijklmnop',
      history,
      bundle,
      config,
      tools: [lookup, probe],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    expect(seen).toBeDefined();
    expect(seen!.has('https://example.com/start?ref=abcdefghijklmnop')).toBe(true);
    expect(seen!.has('https://docs.example.com/api?version=2024-01-01T00:00')).toBe(true);
    expect([...seen!].some(u => u.includes('model.example'))).toBe(false);
  });
});
