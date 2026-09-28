import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// The engine's own decode stats (#536): llama.cpp hangs a `timings` object off the final chunk of
// its `/v1` stream, next to `usage` and outside it. This is where that wire shape stops — the loop
// reads a normalized trio, and a stream that carries none of it (every hosted API) has to leave the
// field absent rather than present-and-empty, since absent is what sends the rate back to the
// derivation (agent/decoderate.ts).

const h = vi.hoisted(() => ({
  scripted: [] as ChatCompletionChunk[][],
}));

vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    void opts;
    const chunks = h.scripted.shift() ?? [];
    return (async function* () {
      for (const c of chunks) yield c;
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

const call = () => callModel({ system: 'sys', history: [], tools: [], config: config() });

const text = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });
// The final chunk of a llama.cpp stream: usage and, beside it at the top level, the round's stats.
const finalChunk = (timings: unknown): ChatCompletionChunk =>
  ({
    choices: [],
    usage: { prompt_tokens: 5000, completion_tokens: 600 },
    timings,
  }) as ChatCompletionChunk;

describe('engine decode stats (issue #536)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    resetLogprobSupport();
  });

  it('normalizes the stats the engine reported with the call', async () => {
    h.scripted.push([
      text('Read'),
      finalChunk({ predicted_n: 600, predicted_ms: 30_000, predicted_per_second: 19.5 }),
    ]);
    expect((await call()).engineTimings).toEqual({
      predictedN: 600,
      predictedMs: 30_000,
      perSecond: 19.5,
    });
  });

  // Every field is read or none is: the count and the window are what let the rate be bounded as a
  // measurement, and a rate without them is a number the module could only take on faith.
  it('reads nothing from a partial stats object', async () => {
    h.scripted.push([text('Read'), finalChunk({ predicted_per_second: 19.5 })]);
    expect((await call()).engineTimings).toBeUndefined();
  });

  it('reads nothing from stats that are not numbers', async () => {
    h.scripted.push([
      text('Read'),
      finalChunk({ predicted_n: 600, predicted_ms: null, predicted_per_second: '19.5' }),
    ]);
    expect((await call()).engineTimings).toBeUndefined();
  });

  // A plain OpenAI-compatible stream carries no such field: absent, so the round keeps the derived
  // rate rather than reporting a zero or an empty object.
  it('leaves the field absent when the engine reported nothing', async () => {
    h.scripted.push([text('Read'), text('ing.')]);
    expect((await call()).engineTimings).toBeUndefined();
  });

  // Under `timings_per_token` llama.cpp sends them on every chunk as running totals, so the last
  // one is the round's own — the same one the final chunk would have carried.
  it('keeps the last stats when every chunk carries them', async () => {
    h.scripted.push([
      { ...text('Read'), timings: { predicted_n: 1, predicted_ms: 40, predicted_per_second: 25 } },
      { ...text('ing.'), timings: { predicted_n: 2, predicted_ms: 80, predicted_per_second: 25 } },
      finalChunk({ predicted_n: 600, predicted_ms: 30_000, predicted_per_second: 19.5 }),
    ]);
    expect((await call()).engineTimings?.perSecond).toBe(19.5);
  });
});
