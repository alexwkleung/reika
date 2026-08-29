import { describe, expect, it, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { createSSEDecoder, streamChatCompletion, tokenize } from './transport.js';
import type { ChatCompletionChunk, ChatCompletionRequest, SSEEvent } from './transport.js';
import { resetStreamDispatcher } from './dispatcher.js';

const enc = new TextEncoder();

// Feed a string to the decoder, optionally splitting it into byte fragments at the given
// boundaries, to simulate arbitrary network read boundaries.
function decodeAll(text: string, splitAt: number[] = []): SSEEvent[] {
  const bytes = enc.encode(text);
  const cuts = [0, ...splitAt, bytes.length];
  const decoder = createSSEDecoder();
  const events: SSEEvent[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    events.push(...decoder.push(bytes.slice(cuts[i], cuts[i + 1])));
  }
  events.push(...decoder.flush());
  return events;
}

function chunks(events: SSEEvent[]): ChatCompletionChunk[] {
  return events
    .filter(e => e.kind === 'chunk')
    .map(e => (e as { chunk: ChatCompletionChunk }).chunk);
}

describe('createSSEDecoder', () => {
  it('decodes a simple data frame', () => {
    const events = decodeAll('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(chunks(events)).toHaveLength(1);
    expect(chunks(events)[0].choices?.[0]?.delta?.content).toBe('hi');
  });

  it('emits a done event for [DONE]', () => {
    const events = decodeAll('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    expect(events.map(e => e.kind)).toEqual(['chunk', 'done']);
  });

  it('reassembles a frame split across reads at an arbitrary byte boundary', () => {
    const frame = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    // Split mid-JSON — the decoder must buffer until the newline arrives.
    for (const cut of [5, 20, frame.length - 3]) {
      const out = chunks(decodeAll(frame, [cut]));
      expect(out).toHaveLength(1);
      expect(out[0].choices?.[0]?.delta?.content).toBe('hello');
    }
  });

  it('reassembles a multi-byte UTF-8 char split across two reads', () => {
    // "café" — the é is two bytes; cut between them so a naive per-chunk decode would corrupt it.
    const frame = 'data: {"choices":[{"delta":{"content":"café"}}]}\n\n';
    const bytes = enc.encode(frame);
    const eIdx = frame.indexOf('é');
    // Byte offset of the first byte of é (ASCII prefix means char index == byte index here).
    const out = chunks(decodeAll(frame, [eIdx + 1]));
    expect(out[0].choices?.[0]?.delta?.content).toBe('café');
    expect(bytes.length).toBeGreaterThan(frame.length); // sanity: é really is multi-byte
  });

  it('skips keep-alive comment lines and non-data fields', () => {
    const text = ': keep-alive\nevent: message\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('x');
  });

  it('tolerates CRLF line endings', () => {
    const out = chunks(decodeAll('data: {"choices":[{"delta":{"content":"y"}}]}\r\n\r\n'));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('y');
  });

  it('parses a trailing frame with no terminating newline on flush', () => {
    const out = chunks(decodeAll('data: {"choices":[{"delta":{"content":"tail"}}]}'));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('tail');
  });

  it('drops an unparseable frame without crashing the stream', () => {
    const text = 'data: {bad json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out).toHaveLength(1);
    expect(out[0].choices?.[0]?.delta?.content).toBe('ok');
  });

  it('decodes a usage-only final frame (cache + tokens)', () => {
    const text =
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,' +
      '"prompt_tokens_details":{"cached_tokens":4}}}\n\n';
    const u = chunks(decodeAll(text))[0].usage;
    expect(u?.prompt_tokens).toBe(10);
    expect(u?.prompt_tokens_details?.cached_tokens).toBe(4);
  });

  it('handles multiple frames delivered in one read', () => {
    const text =
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n';
    const out = chunks(decodeAll(text));
    expect(out.map(c => c.choices?.[0]?.delta?.content)).toEqual(['a', 'b']);
  });
});

describe('tokenize', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to /tokenize at the server root, stripping a trailing /v1', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ids = await tokenize({
      baseURL: 'http://localhost:8080/v1',
      apiKey: '',
      content: ' word',
    });
    expect(ids).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/tokenize');
  });

  it('returns null on a non-2xx (endpoint absent on this backend)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    expect(await tokenize({ baseURL: 'http://x/v1', apiKey: '', content: 'a' })).toBeNull();
  });

  it('returns null on an unrecognized response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })),
    );
    expect(await tokenize({ baseURL: 'http://x/v1', apiKey: '', content: 'a' })).toBeNull();
  });

  it('returns null on a network error rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await tokenize({ baseURL: 'http://x/v1', apiKey: '', content: 'a' })).toBeNull();
  });
});

// The silent-stream timeout (issue #186), end to end against a real socket: undici's own timers
// are what fire, so a stub can't prove this. `respond` decides what the server does with the
// request — return without writing to hang the client the way a prefilling llama.cpp does.
async function withServer(
  respond: (res: ServerResponse) => void,
  run: (baseURL: string, requests: () => number) => Promise<void>,
): Promise<void> {
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests++;
    respond(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}/v1`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const BODY: ChatCompletionRequest = { model: 'm', messages: [], stream: true };

async function drain(baseURL: string): Promise<string> {
  let text = '';
  for await (const chunk of streamChatCompletion({ baseURL, apiKey: '', body: BODY })) {
    text += chunk.choices?.[0]?.delta?.content ?? '';
  }
  return text;
}

describe('silent-stream timeout', () => {
  const PRIOR = process.env.REIKA_REQUEST_TIMEOUT_MS;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.REIKA_REQUEST_TIMEOUT_MS;
    else process.env.REIKA_REQUEST_TIMEOUT_MS = PRIOR;
    resetStreamDispatcher();
  });

  function setTimeoutMs(ms: string): void {
    process.env.REIKA_REQUEST_TIMEOUT_MS = ms;
    resetStreamDispatcher();
  }

  it('aborts a server that never sends headers, and says which knob to raise', async () => {
    setTimeoutMs('300');
    await withServer(
      () => {
        /* never responds — the prefill case */
      },
      async (baseURL, requests) => {
        await expect(drain(baseURL)).rejects.toThrow(/REIKA_REQUEST_TIMEOUT_MS/);
        // Retrying buys the same silent wait over again, so a timeout must not be retried.
        expect(requests()).toBe(1);
      },
    );
  }, 15000);

  it('aborts a stream that stalls after some content', async () => {
    setTimeoutMs('300');
    await withServer(
      res => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      },
      async baseURL => {
        await expect(drain(baseURL)).rejects.toThrow(/stream stalled.*REIKA_REQUEST_TIMEOUT_MS/s);
      },
    );
  }, 15000);

  it('streams normally with the dispatcher installed', async () => {
    setTimeoutMs('5000');
    await withServer(
      res => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      },
      async baseURL => {
        expect(await drain(baseURL)).toBe('hello');
      },
    );
  }, 15000);
});
