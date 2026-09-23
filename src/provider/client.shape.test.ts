import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Message } from '../types.js';
import type { ChatCompletionChunk, ChatCompletionRequest } from './transport.js';

// The two shape 400s a strict upstream (OpenCode Go's validator) throws a few rounds in: a pruned
// old `reasoning_content` ("must be passed back to the API") and the `name` on tool messages
// (`"name"` is not supported). What is pinned here: the rejected request is retried once
// reshaped, every later request in the session carries the accepted shape, an unclassified 400
// is NOT retried, and a repeat of an already-latched rejection is rethrown rather than looped.

const h = vi.hoisted(() => ({
  // One entry per expected call: the chunks to emit, or an error to throw instead of streaming.
  scripted: [] as { chunks?: ChatCompletionChunk[]; error?: string }[],
  bodies: [] as ChatCompletionRequest[],
}));

vi.mock('./transport.js', () => ({
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

// Two tool rounds so reasoningRounds: 1 prunes the older one — that pruned byte is what the
// endpoint then demands back, and the tool messages carry the `name` it refuses.
const history: Message[] = [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a' } }],
    reasoning: 'old think',
  },
  { role: 'tool', callId: 'c1', summary: 'read a', payload: 'AAA' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c2', name: 'read', args: { path: 'b' } }],
    reasoning: 'new think',
  },
  { role: 'tool', callId: 'c2', summary: 'read b', payload: 'BBB' },
];

const REASONING_400 =
  'chat/completions failed: 400 Bad Request — {"error":{"param":null,"type":"invalid_request_error","code":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API."}}';

const NAME_400 =
  'chat/completions failed: 400 Bad Request — {"error":{"param":"messages","type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] messages[3]: \\"name\\" is not supported by this endpoint"}}';

const textChunk = (content: string): ChatCompletionChunk => ({ choices: [{ delta: { content } }] });

const call = () => callModel({ system: 'sys', history, tools: [], config: config() });

const reasonings = (body: ChatCompletionRequest): Array<string | undefined> =>
  body.messages
    .filter(m => m.role === 'assistant')
    .map(m => (m as { reasoning_content?: string }).reasoning_content);

const toolMsgs = (body: ChatCompletionRequest): Array<{ name?: string }> =>
  body.messages.filter(m => m.role === 'tool') as Array<{ name?: string }>;

describe('callModel shape rejections (strict upstreams)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.bodies.length = 0;
    resetLogprobSupport();
  });

  it('defaults to the rejected shape: old reasoning pruned, tool messages named', async () => {
    h.scripted.push({ chunks: [textChunk('ok')] });
    await call();
    expect(h.bodies).toHaveLength(1);
    expect(reasonings(h.bodies[0])).toEqual([undefined, 'new think']);
    expect(toolMsgs(h.bodies[0])[0].name).toBe('read');
  });

  it('retries reshaped after the reasoning 400, then latches the roundtrip on', async () => {
    h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('recovered')] });
    const r = await call();
    expect(r.content).toBe('recovered');
    expect(h.bodies).toHaveLength(2);
    expect(reasonings(h.bodies[0])).toEqual([undefined, 'new think']);
    expect(reasonings(h.bodies[1])).toEqual(['old think', 'new think']);

    // Latched: the next call goes straight to the accepted shape — one body, no failed round-trip.
    h.scripted.push({ chunks: [textChunk('second')] });
    await call();
    expect(h.bodies).toHaveLength(3);
    expect(reasonings(h.bodies[2])).toEqual(['old think', 'new think']);
  });

  it('retries reshaped after the name 400, then latches that off too', async () => {
    h.scripted.push({ error: NAME_400 }, { chunks: [textChunk('recovered')] });
    const r = await call();
    expect(r.content).toBe('recovered');
    expect(h.bodies).toHaveLength(2);
    expect(toolMsgs(h.bodies[0])[0].name).toBe('read');
    expect(toolMsgs(h.bodies[1])[0]).not.toHaveProperty('name');

    h.scripted.push({ chunks: [textChunk('second')] });
    await call();
    expect(h.bodies).toHaveLength(3);
    expect(toolMsgs(h.bodies[2])[0]).not.toHaveProperty('name');
  });

  it('rethrows an unclassified 400 without spending a retry', async () => {
    h.scripted.push({
      error:
        'chat/completions failed: 400 Bad Request — {"error":{"message":"context length exceeded"}}',
    });
    await expect(call()).rejects.toThrow('400 Bad Request');
    expect(h.bodies).toHaveLength(1);
  });

  it('rethrows a repeat of an already-latched rejection instead of looping', async () => {
    h.scripted.push({ error: NAME_400 }, { chunks: [textChunk('ok')] });
    await call();
    expect(h.bodies).toHaveLength(2);
    h.scripted.push({ error: NAME_400 });
    await expect(call()).rejects.toThrow('is not supported');
    expect(h.bodies).toHaveLength(3);
  });

  it('re-renders and re-caps frozen payloads on the retry (prefix-stable)', async () => {
    // Prefix-stable pruning is driven by the aging sweep's mark, not the round window — so the
    // pruned byte the endpoint demands back is one the sweep already spent.
    const big = (): Message[] => {
      const h: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a' } }],
          reasoning: 'old think '.repeat(500),
        },
        { role: 'tool', callId: 'c1', summary: 'read a', payload: 'X'.repeat(20000) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c2', name: 'read', args: { path: 'b' } }],
          reasoning: 'new think',
        },
        { role: 'tool', callId: 'c2', summary: 'read b', payload: 'X'.repeat(20000) },
      ];
      (h[1] as Message & { reasoningAged?: boolean }).reasoningAged = true;
      return h;
    };
    const bigConfig = { ...config(), contextWindow: 4096 };
    const run = (hist: Message[]) =>
      callModel({
        system: 'sys',
        history: hist,
        tools: [],
        config: bigConfig,
        prefixStable: true,
      });
    const lengths = (body: ChatCompletionRequest): number[] =>
      body.messages
        .filter(m => m.role === 'tool')
        .map(m => (m as { content: string }).content.length);

    h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('recovered')] });
    await run(big());
    expect(reasonings(h.bodies[0])).toEqual([undefined, 'new think']);

    // The retry carries the reasoning back — and re-caps the payloads to make room, instead of
    // resending the bytes frozen for the smaller request (which the cap counts as a fixed cost).
    expect(reasonings(h.bodies[1])).toEqual(['old think '.repeat(500), 'new think']);
    expect(lengths(h.bodies[1])[0]).toBeLessThan(lengths(h.bodies[0])[0]);

    // Byte-for-byte what a session that already knew the shape sends on its first try.
    h.scripted.push({ chunks: [textChunk('second')] });
    await run(big());
    expect(lengths(h.bodies[2])).toEqual(lengths(h.bodies[1]));
    expect(reasonings(h.bodies[2])).toEqual(reasonings(h.bodies[1]));
  });
  describe('per endpoint', () => {
    const at = (baseURL: string, model = 'test') =>
      callModel({ system: 'sys', history, tools: [], config: { ...config(), baseURL, model } });
    const STRICT = 'https://router.example.com/v1';
    const LOCAL = 'http://localhost:8080/v1';

    it('keeps a latch to the endpoint that refused, and holds it on the way back', async () => {
      h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('ok')] });
      await at(STRICT);
      h.scripted.push({ error: NAME_400 }, { chunks: [textChunk('ok')] });
      await at(STRICT);
      expect(h.bodies).toHaveLength(4);

      // A switch to another server sends the default shape: pruned reasoning, named tool messages.
      h.scripted.push({ chunks: [textChunk('local')] });
      await at(LOCAL);
      expect(h.bodies).toHaveLength(5);
      expect(reasonings(h.bodies[4])).toEqual([undefined, 'new think']);
      expect(toolMsgs(h.bodies[4])[0].name).toBe('read');

      // Switching back needs no second 400: the strict endpoint's shape went first time.
      h.scripted.push({ chunks: [textChunk('back')] });
      await at(`${STRICT}/`);
      expect(h.bodies).toHaveLength(6);
      expect(reasonings(h.bodies[5])).toEqual(['old think', 'new think']);
      expect(toolMsgs(h.bodies[5])[0]).not.toHaveProperty('name');
    });

    it('treats another model on the same router as its own endpoint', async () => {
      h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('ok')] });
      await at(STRICT, 'thinking-model');
      h.scripted.push({ chunks: [textChunk('other')] });
      await at(STRICT, 'other-model');
      expect(h.bodies).toHaveLength(3);
      expect(reasonings(h.bodies[2])).toEqual([undefined, 'new think']);
    });
  });

  describe('against payloads a previous request froze (prefix-stable)', () => {
    // Round 1 is sent (and stamped) by an earlier call; round 2 arrives with the rejected request.
    // Each read sits between the small-payload floor and the protected-read floor, so only the
    // newest one is guaranteed verbatim and the older one is cut whenever it rejoins the split.
    const PAYLOAD = 3500;
    const round = (n: number, reasoning: string): Message[] => [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${n}`, name: 'read', args: { path: `f${n}` } }],
        reasoning,
      },
      { role: 'tool', callId: `c${n}`, summary: `read f${n}`, payload: String(n).repeat(PAYLOAD) },
    ];
    const run = (hist: Message[]) =>
      callModel({
        system: 'sys',
        history: hist,
        tools: [],
        config: { ...config(), contextWindow: 4096 },
        prefixStable: true,
      });
    const toolContents = (body: ChatCompletionRequest): string[] =>
      body.messages.filter(m => m.role === 'tool').map(m => (m as { content: string }).content);
    // Sends round 1 on its own, stamping it, then returns the two-round history for the next call.
    const afterFirstRound = async (): Promise<Message[]> => {
      const hist: Message[] = [{ role: 'user', content: 'go' }, ...round(1, 'r1')];
      h.scripted.push({ chunks: [textChunk('one')] });
      await run(hist);
      hist.push(...round(2, 'r2'));
      (hist[1] as Message & { reasoningAged?: boolean }).reasoningAged = true;
      return hist;
    };

    it('the name retry resends frozen payloads as they were, not re-capped', async () => {
      const hist = await afterFirstRound();
      const frozen = toolContents(h.bodies[0])[0];
      expect(frozen).toBe(`read f1\n\n${'1'.repeat(PAYLOAD)}`);

      h.scripted.push({ error: NAME_400 }, { chunks: [textChunk('recovered')] });
      await run(hist);
      expect(h.bodies).toHaveLength(3);
      expect(toolContents(h.bodies[2])[0]).toBe(frozen);
      expect(toolContents(h.bodies[2])).toEqual(toolContents(h.bodies[1]));
    });

    it('the reasoning retry keeps the newest read verbatim while it re-caps the rest', async () => {
      const hist = await afterFirstRound();
      h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('recovered')] });
      await run(hist);
      expect(h.bodies).toHaveLength(3);
      expect(reasonings(h.bodies[2])).toEqual(['r1', 'r2']);
      const [older, newest] = toolContents(h.bodies[2]);
      expect(newest).toBe(`read f2\n\n${'2'.repeat(PAYLOAD)}`);
      expect(older.length).toBeLessThan(PAYLOAD);
    });

    it('rethrows a reasoning 400 whose latch an earlier call already spent', async () => {
      const hist: Message[] = [{ role: 'user', content: 'go' }, ...round(1, 'r1')];
      (hist[1] as Message & { reasoningAged?: boolean }).reasoningAged = true;
      h.scripted.push({ error: REASONING_400 }, { chunks: [textChunk('one')] });
      await run(hist);
      expect(h.bodies).toHaveLength(2);
      hist.push(...round(2, 'r2'));

      // Re-rendering would re-cap round 1's frozen payload, so the rebuild differs from the refused
      // request — but it carries no reasoning the refused one lacked, so it cannot be accepted.
      h.scripted.push({ error: REASONING_400 });
      await expect(run(hist)).rejects.toThrow('must be passed back');
      expect(h.bodies).toHaveLength(3);
    });
  });
});
