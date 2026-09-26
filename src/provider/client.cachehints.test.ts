import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// The cache hints ride only to hosts that document them, and a rejection naming one degrades once
// per endpoint. What must not happen: a hint reaching a local server, or an unrelated failure
// latching it off for the session.

const h = vi.hoisted(() => ({
  scripted: [] as { chunks?: ChatCompletionChunk[]; error?: string }[],
  bodies: [] as ChatCompletionRequest[],
}));

vi.mock('./transport.js', () => ({
  SESSION_ID: 'session-uuid',
  streamChatCompletion: (opts: { body: ChatCompletionRequest }) => {
    h.bodies.push(opts.body);
    const script = h.scripted.shift() ?? { chunks: [] };
    return (async function* () {
      if (script.error) throw new Error(script.error);
      for (const c of script.chunks ?? []) yield c;
    })();
  },
}));

const { callModel, resetLogprobSupport } = await import('./client.js');
const { cacheControlFor, promptCacheKeyFor } = await import('./cachehints.js');

const config = (baseURL: string, model = 'test'): Config => ({
  baseURL,
  apiKey: 'sk-test',
  model,
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

const call = (baseURL: string, model?: string) =>
  callModel({ system: 'sys', history: [], tools: [], config: config(baseURL, model) });

describe('promptCacheKeyFor', () => {
  it('answers only for documented hosts', () => {
    expect(promptCacheKeyFor('https://api.openai.com/v1')).toBe('session-uuid');
    expect(promptCacheKeyFor('https://api.moonshot.ai/v1')).toBe('session-uuid');
    expect(promptCacheKeyFor('https://API.Moonshot.cn/v1/')).toBe('session-uuid');
    expect(promptCacheKeyFor('http://localhost:8080/v1')).toBeUndefined();
    expect(promptCacheKeyFor('https://opencode.ai/zen/go/v1')).toBeUndefined();
    expect(promptCacheKeyFor('https://api.openai.com.example.net/v1')).toBeUndefined();
    expect(promptCacheKeyFor('not a url')).toBeUndefined();
  });
});

describe('cacheControlFor', () => {
  it('answers only for Anthropic models on OpenRouter', () => {
    const or = 'https://openrouter.ai/api/v1';
    expect(cacheControlFor(or, 'anthropic/claude-sonnet-5')).toEqual({ type: 'ephemeral' });
    expect(cacheControlFor(or, 'Anthropic/Claude-Opus-5')).toEqual({ type: 'ephemeral' });
    expect(cacheControlFor(or, 'openai/gpt-5.6')).toBeUndefined();
    expect(cacheControlFor(or, 'moonshotai/kimi-k3')).toBeUndefined();
    expect(
      cacheControlFor('https://api.openai.com/v1', 'anthropic/claude-sonnet-5'),
    ).toBeUndefined();
    expect(
      cacheControlFor('http://localhost:8080/v1', 'anthropic/claude-sonnet-5'),
    ).toBeUndefined();
  });
});

describe('callModel cache_control', () => {
  const or = 'https://openrouter.ai/api/v1';
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('sends a top-level breakpoint for Claude on OpenRouter, and no prompt_cache_key', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call(or, 'anthropic/claude-sonnet-5');
    expect(h.bodies[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(h.bodies[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('leaves other OpenRouter models without it', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call(or, 'openai/gpt-5.6');
    expect(h.bodies[0]).not.toHaveProperty('cache_control');
  });

  it('drops it once on a rejection naming it, for that model only', async () => {
    h.scripted.push({ error: '400 Bad Request: cache_control is not supported' });
    h.scripted.push({ chunks: [textChunk('ok')] });
    const r = await call(or, 'anthropic/claude-haiku-4.5');
    expect(r.content).toBe('ok');
    expect(h.bodies[1]).not.toHaveProperty('cache_control');

    h.scripted.push({ chunks: [textChunk('y')] });
    await call(or, 'anthropic/claude-haiku-4.5');
    expect(h.bodies[2]).not.toHaveProperty('cache_control');

    h.scripted.push({ chunks: [textChunk('z')] });
    await call(or, 'anthropic/claude-sonnet-5');
    expect(h.bodies[3].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not latch on a failure that says nothing about it', async () => {
    h.scripted.push({ error: '402 Payment Required: insufficient credits' });
    await expect(call(or, 'anthropic/claude-opus-5')).rejects.toThrow('402');
    h.scripted.push({ chunks: [textChunk('x')] });
    await call(or, 'anthropic/claude-opus-5');
    expect(h.bodies[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('callModel prompt_cache_key', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('sends the session id to a documented host', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call('https://api.moonshot.ai/v1');
    expect(h.bodies[0].prompt_cache_key).toBe('session-uuid');
  });

  it('leaves a local request without the field', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call('http://localhost:8080/v1');
    expect(h.bodies[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('drops the field once on a rejection naming it, then stops sending it', async () => {
    h.scripted.push({ error: '400 Bad Request: unknown field prompt_cache_key' });
    h.scripted.push({ chunks: [textChunk('ok')] });
    const r = await call('https://api.openai.com/v1');
    expect(r.content).toBe('ok');
    expect(h.bodies[0].prompt_cache_key).toBe('session-uuid');
    expect(h.bodies[1]).not.toHaveProperty('prompt_cache_key');

    h.scripted.push({ chunks: [textChunk('y')] });
    await call('https://api.openai.com/v1');
    expect(h.bodies[2]).not.toHaveProperty('prompt_cache_key');
  });

  it('does not latch on a failure that says nothing about the field', async () => {
    h.scripted.push({ error: '401 Unauthorized: invalid api key' });
    await expect(call('https://api.moonshot.ai/v1')).rejects.toThrow('401');
    expect(h.bodies).toHaveLength(1);

    h.scripted.push({ chunks: [textChunk('x')] });
    await call('https://api.moonshot.ai/v1');
    expect(h.bodies[1].prompt_cache_key).toBe('session-uuid');
  });
});
