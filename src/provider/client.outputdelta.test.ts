import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// The live status counts everything a round generates (#925). A round that only calls a tool
// streams nothing through the content or reasoning callbacks, so it would otherwise sit at zero.
const h = vi.hoisted(() => ({
  chunks: [] as ChatCompletionChunk[],
  sent: [] as ChatCompletionRequest[],
  rejectField: undefined as string | undefined,
}));
vi.mock('./transport.js', () => ({
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    h.sent.push(opts.body);
    return (async function* () {
      if (h.rejectField && h.rejectField in opts.body) {
        throw new Error(`400 unknown field ${h.rejectField}`);
      }
      for (const c of h.chunks) yield c;
    })();
  },
}));

const { callModel, resetLogprobSupport } = await import('./client.js');

const config = {
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'no-key',
  model: 'test',
} as Config;

const delta = (d: object): ChatCompletionChunk =>
  ({ choices: [{ delta: d }] }) as ChatCompletionChunk;

describe('onOutputDelta (#925)', () => {
  it('reports reasoning, content and tool-call text', async () => {
    h.chunks = [
      delta({ reasoning_content: 'think' }),
      delta({ content: 'say' }),
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
    ];
    const seen: string[] = [];
    await callModel({
      system: 's',
      history: [],
      tools: [],
      config,
      onOutputDelta: t => seen.push(t),
    });
    expect(seen).toEqual(['think', 'say', 'read', '{"path":', '"a.ts"}']);
  });
});

const running = (n: number): ChatCompletionChunk =>
  ({
    choices: [{ delta: { content: 'x' } }],
    timings: {
      predicted_n: n,
      predicted_ms: n * 50,
      predicted_per_second: 20,
      prompt_n: 300,
      cache_n: 7000,
    },
  }) as ChatCompletionChunk;

describe('onEngineTimings (#925)', () => {
  beforeEach(() => {
    h.chunks = [];
    h.sent.length = 0;
    h.rejectField = undefined;
    resetLogprobSupport();
  });

  const listen = (baseURL = 'http://localhost:8080/v1') => {
    const seen: number[] = [];
    const run = callModel({
      system: 's',
      history: [],
      tools: [],
      config: { ...config, baseURL },
      onEngineTimings: t => seen.push(t.predictedN),
    });
    return { seen, run };
  };

  it('asks a local engine and reports each running total', async () => {
    h.chunks = [running(1), running(2)];
    const { seen, run } = listen();
    await run;
    expect(h.sent[0].timings_per_token).toBe(true);
    expect(seen).toEqual([1, 2]);
  });

  it('does not report prefill, where nothing has been predicted', async () => {
    h.chunks = [running(0), running(1)];
    const { seen, run } = listen();
    await run;
    expect(seen).toEqual([1]);
  });

  it('asks no hosted API', async () => {
    const { run } = listen('https://api.example.com/v1');
    await run;
    expect(h.sent[0]).not.toHaveProperty('timings_per_token');
  });

  it('adds nothing to a call with no listener', async () => {
    await callModel({ system: 's', history: [], tools: [], config });
    expect(h.sent[0]).not.toHaveProperty('timings_per_token');
  });

  it('latches off an engine that rejects the field, and still answers', async () => {
    h.rejectField = 'timings_per_token';
    h.chunks = [{ choices: [{ delta: { content: 'hi' } }] } as ChatCompletionChunk];
    const first = await listen().run;
    expect(first.content).toBe('hi');
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).not.toHaveProperty('timings_per_token');
    await listen().run;
    expect(h.sent[2]).not.toHaveProperty('timings_per_token');
  });
});
