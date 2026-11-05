import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, PromptProgress } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// Chunk shapes captured from llama-server b10680-d7bd3bfca with `return_progress: true` (#912).

const h = vi.hoisted(() => ({
  sent: [] as ChatCompletionRequest[],
  scripted: [] as (ChatCompletionChunk | Error)[][],
}));

vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    h.sent.push(opts.body);
    const items = h.scripted.shift() ?? [];
    return (async function* () {
      for (const item of items) {
        if (item instanceof Error) throw item;
        yield item;
      }
    })();
  },
}));

const { callModel, resetLogprobSupport } = await import('./client.js');

const config = (baseURL = 'http://localhost:8080/v1'): Config => ({
  baseURL,
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

const progress = (processed: number, cache = 0, time_ms = 1000): ChatCompletionChunk => ({
  choices: [{ delta: { content: null } }],
  prompt_progress: { total: 28156, cache, processed, time_ms },
});
const text = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });

const call = (
  onPromptProgress: ((p: PromptProgress | undefined) => void) | undefined,
  baseURL?: string,
) => callModel({ system: 's', history: [], tools: [], config: config(baseURL), onPromptProgress });

describe('prefill progress (#912)', () => {
  beforeEach(() => {
    h.sent.length = 0;
    h.scripted.length = 0;
    resetLogprobSupport();
  });

  it('reports each update, then clears on the first generated token', async () => {
    h.scripted.push([progress(0, 0, 0), progress(2048, 0, 2090), text('hi')]);
    const seen: (PromptProgress | undefined)[] = [];
    const response = await call(p => seen.push(p));
    expect(h.sent[0].return_progress).toBe(true);
    expect(seen).toEqual([
      { total: 28156, cached: 0, processed: 0, elapsedMs: 0 },
      { total: 28156, cached: 0, processed: 2048, elapsedMs: 2090 },
      undefined,
    ]);
    expect(response.content).toBe('hi');
    expect(response.timing).toBeDefined();
  });

  it('clears when the stream ends with no token, so the label cannot outlive the call', async () => {
    h.scripted.push([progress(2048)]);
    const seen: (PromptProgress | undefined)[] = [];
    await call(p => seen.push(p));
    expect(seen.at(-1)).toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  it('leaves the request unchanged without a listener', async () => {
    h.scripted.push([text('hi')]);
    await call(undefined);
    expect(h.sent[0]).not.toHaveProperty('return_progress');
  });

  it('never asks a hosted API', async () => {
    h.scripted.push([text('hi')]);
    await call(() => {}, 'https://api.example.com/v1');
    expect(h.sent[0]).not.toHaveProperty('return_progress');
  });

  it('latches the field off when the engine rejects it by name', async () => {
    h.scripted.push([new Error('400 unknown field: return_progress')], [text('hi')], [text('yo')]);
    const response = await call(() => {});
    expect(response.content).toBe('hi');
    expect(h.sent[0].return_progress).toBe(true);
    expect(h.sent[1]).not.toHaveProperty('return_progress');
    await call(() => {});
    expect(h.sent[2]).not.toHaveProperty('return_progress');
  });

  it('keeps a stream that dies during prefill retryable', async () => {
    h.scripted.push([progress(2048), new Error('terminated')], [text('hi')]);
    const response = await callModel({
      system: 's',
      history: [],
      tools: [],
      config: config(),
      logprobs: 5,
      onPromptProgress: () => {},
    });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).not.toHaveProperty('logprobs');
    expect(response.content).toBe('hi');
  });

  it('ignores a partial progress object rather than guess at it', async () => {
    h.scripted.push([
      { choices: [{ delta: {} }], prompt_progress: { total: 10 } } as ChatCompletionChunk,
      text('hi'),
    ]);
    const seen: (PromptProgress | undefined)[] = [];
    await call(p => seen.push(p));
    expect(seen).toEqual([]);
  });
});
