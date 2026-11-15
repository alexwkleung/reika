import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../protocol.js';
import {
  backoffMs,
  MAX_BACKOFF_MS,
  openEventStream,
  parseSseChunk,
  type SseFrame,
  type StreamStatus,
  type Timers,
} from './eventstream.js';

function parseAll(chunks: string[]): SseFrame[] {
  let rest = '';
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    const parsed = parseSseChunk(rest, chunk);
    rest = parsed.rest;
    frames.push(...parsed.frames);
  }
  return frames;
}

describe('parseSseChunk', () => {
  it('reads the frames the server writes', () => {
    expect(parseAll(['id: 3\ndata: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual([
      { id: '3', data: '{"a":1}' },
      { data: '{"b":2}' },
    ]);
  });

  it('joins a frame split at any byte', () => {
    const text = 'id: 1\ndata: {"x":"hello"}\n\n';
    for (let i = 1; i < text.length; i++) {
      expect(parseAll([text.slice(0, i), text.slice(i)])).toEqual([
        { id: '1', data: '{"x":"hello"}' },
      ]);
    }
  });

  it('joins multi-line data with newlines', () => {
    expect(parseAll(['data: one\ndata: two\ndata:three\n\n'])).toEqual([
      { data: 'one\ntwo\nthree' },
    ]);
  });

  it('skips comment lines and dispatches nothing for a heartbeat', () => {
    expect(parseAll([': ping\n\n', ': ping\n\ndata: x\n: mid\n\n'])).toEqual([{ data: 'x' }]);
  });

  it('reads CRLF and bare CR line ends, a CRLF split across chunks included', () => {
    expect(parseAll(['data: a\r\n\r\ndata: b\r\rdata: c\r', '\n\r', '\n'])).toEqual([
      { data: 'a' },
      { data: 'b' },
      { data: 'c' },
    ]);
  });

  it('keeps an unfinished frame in rest', () => {
    const parsed = parseSseChunk('', 'data: partial\n');
    expect(parsed.frames).toEqual([]);
    expect(parsed.rest).toBe('data: partial\n');
  });

  it('reads an event field and a field with no colon', () => {
    expect(parseAll(['event: x\ndata\n\n'])).toEqual([{ event: 'x', data: '' }]);
  });
});

describe('backoffMs', () => {
  it('doubles from half a second up to the cap', () => {
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([500, 1000, 2000, 4000]);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });
});

// A timer queue the test advances by hand.
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: id => void pending.delete(id as number),
  };
  return {
    timers,
    pending,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

// A response whose body the test writes to, and which errors on abort as a real fetch body does.
function streamResponse(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: c => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: (signal: AbortSignal) => {
      signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      return new Response(body, { status });
    },
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

function harness(
  responses: ((signal: AbortSignal) => Response | Promise<Response>)[],
  resume: () => number | null = () => null,
) {
  const t = fakeTimers();
  const calls: { url: string; init: RequestInit }[] = [];
  const events: ServerEvent[] = [];
  const statuses: StreamStatus[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const make = responses.shift();
    if (!make) return new Promise<Response>(() => {});
    return make(init!.signal!);
  }) as typeof fetch;
  const stream = openEventStream({
    token: 'secret',
    resumeFrom: resume,
    onEvent: e => events.push(e),
    onStatus: s => statuses.push(s),
    fetch: fetchFn,
    timers: t.timers,
    stallMs: 1000,
  });
  return { ...t, calls, events, statuses, stream };
}

const frame = (event: ServerEvent) =>
  `${'seq' in event ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`;

describe('openEventStream', () => {
  it('sends the token in a header only and reports open', async () => {
    const s = streamResponse();
    const h = harness([s.response]);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('/events');
    expect(h.calls[0]!.url).not.toContain('secret');
    const headers = new Headers(h.calls[0]!.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret');
    expect(headers.has('Last-Event-ID')).toBe(false);
    expect(h.statuses).toEqual(['connecting', 'open']);
    h.stream.close();
  });

  it('delivers parsed events across split chunks and skips heartbeats and bad JSON', async () => {
    const s = streamResponse();
    const h = harness([s.response]);
    await settle();
    const text =
      frame({ type: 'hello', seq: 0, version: 1 }) +
      ': ping\n\n' +
      'data: {nope\n\n' +
      frame({ type: 'delta', channel: 'content', text: 'hi' });
    s.write(text.slice(0, 13));
    s.write(text.slice(13));
    await settle();
    expect(h.events).toEqual([
      { type: 'hello', seq: 0, version: 1 },
      { type: 'delta', channel: 'content', text: 'hi' },
    ]);
    h.stream.close();
  });

  it('reconnects after the stream ends, resuming from the seq the tab holds', async () => {
    let seq: number | null = null;
    const first = streamResponse();
    const second = streamResponse();
    const h = harness([first.response, second.response], () => seq);
    await settle();
    seq = 12;
    first.end();
    await settle();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    expect(h.calls).toHaveLength(1);
    h.advance(backoffMs(0));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(new Headers(h.calls[1]!.init.headers).get('Last-Event-ID')).toBe('12');
    expect(h.calls[1]!.url).toBe('/events');
    expect(h.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    h.stream.close();
  });

  it('backs off further after each failed attempt and resets once open', async () => {
    const ok = streamResponse();
    const h = harness([
      () => Promise.reject(new Error('refused')),
      () => new Response('busy', { status: 503 }),
      ok.response,
    ]);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.advance(backoffMs(0) - 1);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await settle();
    expect(h.calls).toHaveLength(2);
    h.advance(backoffMs(1) - 1);
    await settle();
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.statuses.at(-1)).toBe('open');
    h.stream.close();
  });

  it('stops on 401 and reports signed-out', async () => {
    const h = harness([() => new Response('unauthorized', { status: 401 })]);
    await settle();
    expect(h.statuses).toEqual(['connecting', 'signed-out']);
    h.advance(MAX_BACKOFF_MS * 10);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.pending.size).toBe(0);
  });

  it('aborts a stream that goes quiet past the stall bound and reconnects', async () => {
    const first = streamResponse();
    const second = streamResponse();
    const h = harness([first.response, second.response]);
    await settle();
    // Bytes keep it alive.
    h.advance(900);
    first.write(': ping\n\n');
    await settle();
    h.advance(900);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.advance(200);
    await settle();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.advance(backoffMs(0));
    await settle();
    expect(h.calls).toHaveLength(2);
    h.stream.close();
  });

  it('a request that never answers is a stall too', async () => {
    const second = streamResponse();
    let aborted = false;
    const h = harness([
      signal =>
        new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      second.response,
    ]);
    await settle();
    h.advance(1000);
    await settle();
    expect(aborted).toBe(true);
    h.advance(backoffMs(0));
    await settle();
    expect(h.calls).toHaveLength(2);
    h.stream.close();
  });

  it('close stops the stream, its timers and any further events or status', async () => {
    const s = streamResponse();
    const h = harness([s.response]);
    await settle();
    h.stream.close();
    await settle();
    expect(h.pending.size).toBe(0);
    const before = h.statuses.length;
    h.advance(MAX_BACKOFF_MS * 10);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.statuses).toHaveLength(before);
  });
});
