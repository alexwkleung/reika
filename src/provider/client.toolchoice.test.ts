import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Tool } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// `toolChoice: 'none'` (#426) exists so a report round keeps the tool list in the prompt the
// template renders — the alternative, sending no tools, re-prefills the whole request. What is
// pinned here is the wire shape (tools stay, the field rides along), and that a backend rejecting
// the field degrades to the old no-tools request once and then stops asking.

const h = vi.hoisted(() => ({
  scripted: [] as { chunks?: ChatCompletionChunk[]; throwAt?: 'start' | 'mid' }[],
  bodies: [] as ChatCompletionRequest[],
}));

vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    h.bodies.push(opts.body);
    const script = h.scripted.shift() ?? { chunks: [] };
    return (async function* () {
      if (script.throwAt === 'start') throw new Error('400 Bad Request: unknown field tool_choice');
      for (const c of script.chunks ?? []) yield c;
      if (script.throwAt === 'mid') throw new Error('connection reset');
    })();
  },
}));

const { callModel, resetLogprobSupport } = await import('./client.js');

const config = (): Config => ({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'no-key',
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
});

const readTool: Tool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  run: async () => ({ summary: '', payload: '' }),
};

const textChunk = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });

const call = (opts: { tools: Tool[]; toolChoice?: 'none' }) =>
  callModel({ system: 'sys', history: [], config: config(), ...opts });

describe('callModel toolChoice (#426)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('keeps the tools in the request and adds tool_choice: none', async () => {
    h.scripted.push({ chunks: [textChunk('note')] });
    const r = await call({ tools: [readTool], toolChoice: 'none' });
    expect(r.content).toBe('note');
    expect(h.bodies[0].tools?.map(t => t.function.name)).toEqual(['read']);
    expect(h.bodies[0].tool_choice).toBe('none');
  });

  it('sends neither field when there are no tools to forbid', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call({ tools: [], toolChoice: 'none' });
    expect(h.bodies[0]).not.toHaveProperty('tools');
    expect(h.bodies[0]).not.toHaveProperty('tool_choice');
  });

  it('leaves a normal round byte-identical', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call({ tools: [readTool] });
    expect(h.bodies[0].tools).toHaveLength(1);
    expect(h.bodies[0]).not.toHaveProperty('tool_choice');
  });

  it('degrades to the old no-tools request when the backend rejects it, and latches off', async () => {
    h.scripted.push({ throwAt: 'start' }, { chunks: [textChunk('recovered')] });
    const first = await call({ tools: [readTool], toolChoice: 'none' });
    expect(first.content).toBe('recovered');
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[0].tool_choice).toBe('none');
    expect(h.bodies[1]).not.toHaveProperty('tool_choice');
    expect(h.bodies[1]).not.toHaveProperty('tools');

    // Latched: the next report round goes straight to the no-tools shape, no failed round-trip —
    // and a normal round still gets its tools.
    h.scripted.push({ chunks: [textChunk('second')] });
    await call({ tools: [readTool], toolChoice: 'none' });
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[2]).not.toHaveProperty('tools');
    h.scripted.push({ chunks: [textChunk('third')] });
    await call({ tools: [readTool] });
    expect(h.bodies[3].tools).toHaveLength(1);
  });

  it('does not retry after content has streamed', async () => {
    h.scripted.push({ chunks: [textChunk('partial')], throwAt: 'mid' });
    await expect(call({ tools: [readTool], toolChoice: 'none' })).rejects.toThrow(
      'connection reset',
    );
    expect(h.bodies).toHaveLength(1);
  });
});
