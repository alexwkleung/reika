import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// The logprobs plumbing (issue #134) is the one thing that changes the request the engine sees, so
// it is tested against a scripted transport: what goes out on the wire, what comes back normalized,
// and — the part that matters most for an instrumentation-only feature — that a backend rejecting
// the fields costs the turn nothing.

const h = vi.hoisted(() => ({
  // One entry per expected call: the chunks to emit, or an error to throw instead.
  scripted: [] as { chunks?: ChatCompletionChunk[]; throwAt?: 'start' | 'mid' }[],
  bodies: [] as ChatCompletionRequest[],
}));

vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    h.bodies.push(opts.body);
    const script = h.scripted.shift() ?? { chunks: [] };
    return (async function* () {
      if (script.throwAt === 'start')
        throw new Error('400 Bad Request: unknown field top_logprobs');
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

const textChunk = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });

const logprobChunk = (
  content: string,
  tokens: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[],
): ChatCompletionChunk => ({
  choices: [{ delta: { content }, logprobs: { content: tokens } }],
});

const call = (logprobs?: number) =>
  callModel({ system: 'sys', history: [], tools: [], config: config(), logprobs });

describe('callModel logprobs (issue #134)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('leaves the request byte-identical when no logprobs were asked for', async () => {
    h.scripted.push({ chunks: [textChunk('hello')] });
    const res = await call();
    expect(h.bodies[0]).not.toHaveProperty('logprobs');
    expect(h.bodies[0]).not.toHaveProperty('top_logprobs');
    expect(res.sampled).toBeUndefined();
  });

  it('requests the top-k it was given and normalizes what comes back', async () => {
    h.scripted.push({
      chunks: [
        logprobChunk('Hi', [
          {
            token: 'Hi',
            logprob: -0.2,
            top_logprobs: [
              { token: 'Hi', logprob: -0.2 },
              { token: 'Hello', logprob: -1.9 },
            ],
          },
        ]),
        logprobChunk('!', [{ token: '!', logprob: -0.05, top_logprobs: [] }]),
      ],
    });

    const res = await call(5);

    expect(h.bodies[0]).toMatchObject({ logprobs: true, top_logprobs: 5 });
    expect(res.content).toBe('Hi!');
    expect(res.sampled).toEqual([
      {
        token: 'Hi',
        logprob: -0.2,
        top: [
          { token: 'Hi', logprob: -0.2 },
          { token: 'Hello', logprob: -1.9 },
        ],
      },
      // An empty top_logprobs list becomes an absent `top` — "not reported", not "no alternatives".
      { token: '!', logprob: -0.05 },
    ]);
  });

  it('collects logprobs from a chunk that carries no delta at all', async () => {
    h.scripted.push({
      chunks: [{ choices: [{ logprobs: { content: [{ token: 'x', logprob: -1 }] } }] }],
    });
    const res = await call(5);
    expect(res.sampled).toEqual([{ token: 'x', logprob: -1 }]);
  });

  it('ignores a null logprobs field from a backend that echoes it empty', async () => {
    h.scripted.push({ chunks: [{ choices: [{ delta: { content: 'hi' }, logprobs: null }] }] });
    const res = await call(5);
    expect(res.sampled).toBeUndefined();
    expect(res.content).toBe('hi');
  });

  it('degrades to a plain request when the backend rejects the fields, and stops asking', async () => {
    // First call: the engine 400s before a single chunk. The retry (no logprobs) succeeds.
    h.scripted.push({ throwAt: 'start' }, { chunks: [textChunk('recovered')] });
    const first = await call(5);

    expect(first.content).toBe('recovered'); // instrumentation never costs the turn
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[0]).toHaveProperty('logprobs', true);
    expect(h.bodies[1]).not.toHaveProperty('logprobs');
    expect(h.bodies[1]).not.toHaveProperty('top_logprobs');

    // Latched off for this endpoint: the next round pays no failed round-trip.
    h.scripted.push({ chunks: [textChunk('second')] });
    const second = await call(5);
    expect(second.content).toBe('second');
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[2]).not.toHaveProperty('logprobs');
  });

  it('asks another endpoint again after one refused the fields', async () => {
    h.scripted.push({ throwAt: 'start' }, { chunks: [textChunk('recovered')] });
    await call(5);
    h.scripted.push({ chunks: [textChunk('elsewhere')] });
    await callModel({
      system: 'sys',
      history: [],
      tools: [],
      config: { ...config(), baseURL: 'https://api.example.com/v1' },
      logprobs: 5,
    });
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[2]).toMatchObject({ logprobs: true, top_logprobs: 5 });
  });

  it('does not retry after content has streamed — that would duplicate it', async () => {
    h.scripted.push({ chunks: [textChunk('partial')], throwAt: 'mid' });
    await expect(call(5)).rejects.toThrow('connection reset');
    expect(h.bodies).toHaveLength(1);
  });

  it('surfaces a plain-request failure unchanged', async () => {
    h.scripted.push({ throwAt: 'start' });
    await expect(call()).rejects.toThrow('400 Bad Request');
    expect(h.bodies).toHaveLength(1);
  });
});
