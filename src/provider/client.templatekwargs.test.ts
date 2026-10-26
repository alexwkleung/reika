import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// `preserve_thinking` rides only to local and private hosts (#798), and a rejection naming the
// field degrades once per endpoint. What must not happen: the field reaching a hosted API, or an
// unrelated failure (a server still loading) latching it off for the session.

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
const { chatTemplateKwargsFor } = await import('./templatekwargs.js');

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

const preserve = { preserve_thinking: true };

describe('chatTemplateKwargsFor', () => {
  it('answers for loopback, private and dotless hosts', () => {
    expect(chatTemplateKwargsFor('http://localhost:8080/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://127.0.0.1:9931/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://[::1]:8080/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://192.168.1.20:8000/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://100.101.102.103:8080/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://gpu-box.local:8080/v1')).toEqual(preserve);
    expect(chatTemplateKwargsFor('http://gpu-box:8080/v1')).toEqual(preserve);
  });

  it('leaves hosted APIs and unparseable URLs without it', () => {
    expect(chatTemplateKwargsFor('https://api.openai.com/v1')).toBeUndefined();
    expect(chatTemplateKwargsFor('https://openrouter.ai/api/v1')).toBeUndefined();
    expect(chatTemplateKwargsFor('https://8.8.8.8/v1')).toBeUndefined();
    expect(chatTemplateKwargsFor('not a url')).toBeUndefined();
  });

  it('sends nothing under REIKA_PRESERVE_THINKING=0, the #827 test bed', () => {
    process.env.REIKA_PRESERVE_THINKING = '0';
    try {
      expect(chatTemplateKwargsFor('http://localhost:8080/v1')).toBeUndefined();
    } finally {
      delete process.env.REIKA_PRESERVE_THINKING;
    }
  });
});

describe('callModel chat_template_kwargs', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('sends preserve_thinking to a local server', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call('http://localhost:8080/v1');
    expect(h.bodies[0].chat_template_kwargs).toEqual(preserve);
  });

  it('leaves a hosted request without the field', async () => {
    h.scripted.push({ chunks: [textChunk('x')] });
    await call('https://api.openai.com/v1');
    expect(h.bodies[0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('drops the field once on a rejection naming it, for that endpoint only', async () => {
    h.scripted.push({ error: '400 Bad Request: unknown field chat_template_kwargs' });
    h.scripted.push({ chunks: [textChunk('ok')] });
    const r = await call('http://127.0.0.1:8080/v1');
    expect(r.content).toBe('ok');
    expect(h.bodies[0].chat_template_kwargs).toEqual(preserve);
    expect(h.bodies[1]).not.toHaveProperty('chat_template_kwargs');

    h.scripted.push({ chunks: [textChunk('y')] });
    await call('http://127.0.0.1:8080/v1');
    expect(h.bodies[2]).not.toHaveProperty('chat_template_kwargs');

    h.scripted.push({ chunks: [textChunk('z')] });
    await call('http://127.0.0.1:8081/v1');
    expect(h.bodies[3].chat_template_kwargs).toEqual(preserve);
  });

  it('does not latch on a failure that says nothing about the field', async () => {
    h.scripted.push({ error: '503 Service Unavailable: Loading model' });
    await expect(call('http://localhost:9931/v1')).rejects.toThrow('503');
    expect(h.bodies).toHaveLength(1);

    h.scripted.push({ chunks: [textChunk('x')] });
    await call('http://localhost:9931/v1');
    expect(h.bodies[1].chat_template_kwargs).toEqual(preserve);
  });
});
