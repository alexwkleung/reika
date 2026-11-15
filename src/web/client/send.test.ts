import { describe, expect, it, vi } from 'vitest';
import { sendMessage } from './send.js';

function answering(response: Response | Error) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('sendMessage', () => {
  it('posts the message as JSON with the token in a header', async () => {
    const fetchFn = answering(json(200, { ok: true }));
    const result = await sendMessage(
      'tok',
      { type: 'submit', text: 'hi' },
      fetchFn as typeof fetch,
    );
    expect(result).toEqual({ kind: 'ok' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/message');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'submit', text: 'hi' });
  });

  it('a 409 is a conflict carrying the server error', async () => {
    const fetchFn = answering(json(409, { error: 'no open approval dialog d3' }));
    expect(
      await sendMessage(
        'tok',
        { type: 'answer', id: 'd3', kind: 'approval', answer: true },
        fetchFn as typeof fetch,
      ),
    ).toEqual({ kind: 'conflict', error: 'no open approval dialog d3' });
  });

  it('a 401 is signed-out', async () => {
    const fetchFn = answering(new Response('unauthorized', { status: 401 }));
    expect(await sendMessage('tok', { type: 'abort' }, fetchFn as typeof fetch)).toEqual({
      kind: 'signed-out',
    });
  });

  it('other failures carry the status and the server text, JSON or plain', async () => {
    expect(
      await sendMessage(
        't',
        { type: 'abort' },
        answering(json(400, { error: 'bad' })) as typeof fetch,
      ),
    ).toEqual({ kind: 'failed', status: 400, error: 'bad' });
    expect(
      await sendMessage(
        't',
        { type: 'abort' },
        answering(new Response('payload too large', { status: 413 })) as typeof fetch,
      ),
    ).toEqual({ kind: 'failed', status: 413, error: 'payload too large' });
    expect(
      await sendMessage(
        't',
        { type: 'abort' },
        answering(new Response('', { status: 500 })) as typeof fetch,
      ),
    ).toEqual({ kind: 'failed', status: 500, error: 'HTTP 500' });
  });

  it('a network failure has no status', async () => {
    expect(
      await sendMessage('t', { type: 'abort' }, answering(new Error('offline')) as typeof fetch),
    ).toEqual({ kind: 'failed', status: null, error: 'offline' });
  });
});
