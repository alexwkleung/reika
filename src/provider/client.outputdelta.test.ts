import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk } from './transport.js';

// The live status counts everything a round generates (#925). A round that only calls a tool
// streams nothing through the content or reasoning callbacks, so it would otherwise sit at zero.
const h = vi.hoisted(() => ({ chunks: [] as ChatCompletionChunk[] }));
vi.mock('./transport.js', () => ({
  streamChatCompletion: () =>
    (async function* () {
      for (const c of h.chunks) yield c;
    })(),
}));

const { callModel } = await import('./client.js');

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
