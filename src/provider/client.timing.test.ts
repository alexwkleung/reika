import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// Time-to-first-token is the prefill half of a turn's wall clock (issue #195), and the prefill-cost
// instrumentation is only as honest as this measurement — so the clock is scripted: which chunk
// stops it, and that a logprobs degrade re-times from the retry rather than the rejected request.

const h = vi.hoisted(() => ({
  // One entry per expected call: chunks paired with the ms that pass before each arrives.
  scripted: [] as {
    steps: { ms: number; chunk: ChatCompletionChunk }[];
    throwAt?: 'start';
    throwAfterMs?: number;
  }[],
  advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
}));

vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    void opts;
    const script = h.scripted.shift() ?? { steps: [] };
    return (async function* () {
      if (script.throwAt === 'start')
        throw new Error('400 Bad Request: unknown field top_logprobs');
      for (const s of script.steps) {
        h.advance(s.ms);
        yield s.chunk;
      }
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
  pasteFetch: false,
  skillAuto: 'off',
  anon: false,
});

const call = (logprobs?: number) =>
  callModel({ system: 'sys', history: [], tools: [], config: config(), logprobs });

const text = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });
// An opener with a delta that carries no generated tokens (providers send one for the role).
const emptyDelta: ChatCompletionChunk = { choices: [{ delta: {} }] };
const usageOnly: ChatCompletionChunk = {
  choices: [],
  usage: { prompt_tokens: 8952, completion_tokens: 0 },
};

describe('callModel timing (issue #195)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    resetLogprobSupport();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('stops the prefill clock at the first generated token and keeps timing the stream', async () => {
    h.scripted.push({
      steps: [
        { ms: 250_000, chunk: text('Read') },
        { ms: 53_000, chunk: text('ing.') },
      ],
    });
    const r = await call();
    expect(r.timing).toEqual({ ttftMs: 250_000, totalMs: 303_000 });
  });

  // An empty opening delta and a usage-only trailer carry no generated tokens; ending prefill on one
  // would report a 0 s prefill for a round that spent minutes on it.
  it('ignores chunks that carry no generated tokens', async () => {
    h.scripted.push({
      steps: [
        { ms: 10, chunk: emptyDelta },
        { ms: 250_000, chunk: text('Reading.') },
        { ms: 100, chunk: usageOnly },
      ],
    });
    const r = await call();
    expect(r.timing?.ttftMs).toBe(250_010);
  });

  it('times the reasoning channel too', async () => {
    h.scripted.push({
      steps: [{ ms: 4_000, chunk: { choices: [{ delta: { reasoning_content: 'hm' } }] } }],
    });
    expect((await call()).timing?.ttftMs).toBe(4_000);
  });

  it('times a tool call with no text before it', async () => {
    h.scripted.push({
      steps: [
        {
          ms: 7_000,
          chunk: {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }] } },
            ],
          },
        },
      ],
    });
    expect((await call()).timing?.ttftMs).toBe(7_000);
  });

  // A rejected logprobs request is re-sent from scratch; timing the retry from the first attempt's
  // start would charge the failed round-trip to prefill.
  it('re-times from the retry when the backend rejects the logprobs fields', async () => {
    // The rejected attempt burns 5 s before it fails; only the retry's own prefill may be timed.
    h.scripted.push({ steps: [], throwAt: 'start', throwAfterMs: 5_000 });
    h.scripted.push({ steps: [{ ms: 30_000, chunk: text('ok') }] });
    expect((await call(5)).timing?.ttftMs).toBe(30_000);
  });

  it('reports no timing when the stream produced nothing', async () => {
    h.scripted.push({ steps: [{ ms: 1_000, chunk: usageOnly }] });
    expect((await call()).timing).toBeUndefined();
  });
});
