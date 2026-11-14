import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, Server as NetServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { HandleResult, WebBridge } from './bridge.js';
import type { ClientMessage, ServerEvent } from './protocol.js';
import {
  MAX_MESSAGE_BYTES,
  MAX_STREAMS,
  startWebServer,
  type WebServer,
  type WebServerOptions,
} from './server.js';

function fakeBridge(connectEvents: ServerEvent[] = []) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connectCalls: (number | undefined)[] = [];
  const handled: ClientMessage[] = [];
  let result: HandleResult = { ok: true };
  const bridge: WebBridge = {
    connect(afterSeq) {
      connectCalls.push(afterSeq);
      return connectEvents;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handle(message) {
      handled.push(message);
      return result;
    },
    close: vi.fn(),
  };
  return {
    bridge,
    listeners,
    connectCalls,
    handled,
    setResult(next: HandleResult) {
      result = next;
    },
    push(event: ServerEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()));
});

async function start(fake = fakeBridge(), opts: WebServerOptions = {}) {
  const server = await startWebServer(fake.bridge, opts);
  servers.push(server);
  return { server, fake };
}

// Every response the suite sees goes through here, so the no-CORS rule is asserted on all of them.
const seenStatuses = new Set<number>();
function assertNoCorsHeaders(headers: IncomingHttpHeaders, status: number): void {
  seenStatuses.add(status);
  expect(Object.keys(headers).filter(k => k.startsWith('access-control-'))).toEqual([]);
}

type Req = {
  method?: string;
  path?: string;
  // `null` sends no Host at all.
  host?: string | null;
  headers?: Record<string, string>;
  body?: string | Buffer;
  // Sends the body without a Content-Length.
  chunked?: boolean;
};

type Res = { status: number; headers: IncomingHttpHeaders; body: string };

function send(port: number, req: Req = {}): Promise<Res> {
  const headers: Record<string, string> = { ...req.headers };
  const host = req.host === undefined ? `127.0.0.1:${port}` : req.host;
  if (host !== null) headers.Host = host;
  if (req.body !== undefined && !req.chunked) {
    headers['Content-Length'] = String(Buffer.byteLength(req.body));
  }
  return new Promise((resolve, reject) => {
    let response: Res | undefined;
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.path ?? '/',
        headers,
        setHost: false,
        agent: false,
      },
      res => {
        assertNoCorsHeaders(res.headers, res.statusCode ?? 0);
        const answered: Res = { status: res.statusCode ?? 0, headers: res.headers, body: '' };
        response = answered;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        const done = () => {
          answered.body = body;
          resolve(answered);
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    // A refused upload is cut once the answer is out, so a write error after it is expected.
    r.on('error', err => (response ? resolve(response) : reject(err)));
    // Paced, and stopped once an answer is in, so a refused upload is not still being written
    // when the server cuts the socket.
    void (async () => {
      if (req.body !== undefined) {
        const buf = Buffer.from(req.body);
        for (let i = 0; i < buf.length && !response && !r.destroyed; i += 64 * 1024) {
          if (!r.write(buf.subarray(i, i + 64 * 1024))) {
            await new Promise<void>(drained => {
              r.once('drain', drained);
              r.once('close', drained);
            });
          }
        }
      }
      if (!response && !r.destroyed) r.end();
    })();
  });
}

type Stream = {
  status: number;
  headers: IncomingHttpHeaders;
  text: () => string;
  until: (predicate: (text: string) => boolean) => Promise<string>;
  ended: Promise<void>;
  response: IncomingMessage;
  destroy: () => void;
};

function openStream(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<Stream>((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
        setHost: false,
        agent: false,
      },
      res => {
        assertNoCorsHeaders(res.headers, res.statusCode ?? 0);
        let text = '';
        const waiters: (() => void)[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          for (const w of waiters.splice(0)) w();
        });
        const ended = new Promise<void>(done => res.on('close', () => done()));
        const until = async (predicate: (t: string) => boolean): Promise<string> => {
          while (!predicate(text)) {
            await new Promise<void>((wake, fail) => {
              waiters.push(wake);
              setTimeout(() => fail(new Error(`timed out; got ${JSON.stringify(text)}`)), 2000);
            });
          }
          return text;
        };
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => text,
          until,
          ended,
          response: res,
          destroy: () => r.destroy(),
        });
      },
    );
    r.on('error', reject);
    r.end();
  });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise(r => setTimeout(r, 5));
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = { 'Content-Type': 'application/json' };
const submit = JSON.stringify({ type: 'submit', text: 'hi' });

describe('binding', () => {
  it('listens on 127.0.0.1 only', async () => {
    const listen = vi.spyOn(NetServer.prototype, 'listen');
    const { server } = await start();
    expect(listen.mock.calls[0][1]).toBe('127.0.0.1');
    listen.mockRestore();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    const refused = await new Promise<string>(resolve => {
      const socket = connect({ host: '::1', port: server.port });
      socket.on('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(refused).not.toBe('connected');
  });
});

describe('Host', () => {
  it('refuses a missing Host, a foreign hostname, another port, IPv6 and uppercase', async () => {
    const { server } = await start();
    const p = server.port;
    for (const host of [null, `evil.example:${p}`, `127.0.0.1:${p + 1}`, `[::1]:${p}`]) {
      expect((await send(p, { host })).status).toBe(403);
    }
    // Exact match, case included: the page's own URL is lowercase.
    expect((await send(p, { host: `LOCALHOST:${p}` })).status).toBe(403);
    expect((await send(p, { host: '127.0.0.1' })).status).toBe(403);
  });

  it('admits 127.0.0.1 and localhost on the bound port', async () => {
    const { server } = await start();
    const p = server.port;
    expect((await send(p, { host: `127.0.0.1:${p}` })).status).toBe(404);
    expect((await send(p, { host: `localhost:${p}` })).status).toBe(404);
  });

  it('refuses a request naming two hosts', async () => {
    const { server } = await start();
    const p = server.port;
    // Node keeps only the first Host in req.headers, so the count is read off the raw headers.
    const res = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        { host: '127.0.0.1', port: p, path: '/', setHost: false, agent: false },
        res => {
          assertNoCorsHeaders(res.headers, res.statusCode ?? 0);
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.setHeader('Host', [`127.0.0.1:${p}`, 'evil.example']);
      r.on('error', reject);
      r.end();
    });
    expect(res).toBe(403);
  });
});

describe('Origin and Sec-Fetch-Site', () => {
  it('refuses foreign, null, https and other-port origins on GET and POST', async () => {
    const { server, fake } = await start();
    const p = server.port;
    for (const origin of [
      'http://evil.example',
      'null',
      `https://127.0.0.1:${p}`,
      `http://127.0.0.1:${p + 1}`,
    ]) {
      expect((await send(p, { headers: { Origin: origin } })).status).toBe(403);
      const post = await send(p, {
        method: 'POST',
        path: '/message',
        headers: { Origin: origin, ...json, ...bearer(server.token) },
        body: submit,
      });
      expect(post.status).toBe(403);
    }
    expect(fake.handled).toEqual([]);
  });

  it('admits an absent origin and the two exact ones', async () => {
    const { server } = await start();
    const p = server.port;
    expect((await send(p)).status).toBe(404);
    for (const origin of [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) {
      expect((await send(p, { headers: { Origin: origin } })).status).toBe(404);
      const post = await send(p, {
        method: 'POST',
        path: '/message',
        headers: { Origin: origin, ...json, ...bearer(server.token) },
        body: submit,
      });
      expect(post.status).toBe(200);
    }
  });

  it('refuses cross-site and same-site fetches, admits same-origin and none', async () => {
    const { server } = await start();
    const p = server.port;
    for (const site of ['cross-site', 'same-site']) {
      expect((await send(p, { headers: { 'Sec-Fetch-Site': site } })).status).toBe(403);
    }
    for (const site of ['same-origin', 'none']) {
      expect((await send(p, { headers: { 'Sec-Fetch-Site': site } })).status).toBe(404);
    }
  });
});

describe('methods', () => {
  it('answers OPTIONS with 405 and no CORS header', async () => {
    const { server } = await start();
    const res = await send(server.port, {
      method: 'OPTIONS',
      path: '/message',
      headers: {
        Origin: `http://127.0.0.1:${server.port}`,
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(405);
    expect(Object.keys(res.headers).some(k => k.startsWith('access-control-'))).toBe(false);
  });

  it('answers PUT, DELETE and HEAD with 405', async () => {
    const { server } = await start();
    for (const method of ['PUT', 'DELETE', 'HEAD']) {
      expect((await send(server.port, { method, path: '/message' })).status).toBe(405);
    }
  });
});

describe('token', () => {
  it('gates /events: none, wrong and wrong-length refused; query or Bearer admitted', async () => {
    const { server } = await start();
    const p = server.port;
    for (const path of ['/events', '/events?token=wrong', `/events?token=${server.token}x`]) {
      const res = await send(p, { path });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(server.token);
    }
    expect((await send(p, { path: '/events', headers: bearer('nope') })).status).toBe(401);
    const byQuery = await openStream(p, `/events?token=${encodeURIComponent(server.token)}`);
    expect(byQuery.status).toBe(200);
    byQuery.destroy();
    const byHeader = await openStream(p, '/events', bearer(server.token));
    expect(byHeader.status).toBe(200);
    byHeader.destroy();
  });

  it('gates /message by the Bearer header alone', async () => {
    const { server, fake } = await start();
    const p = server.port;
    const post = (path: string, headers: Record<string, string>) =>
      send(p, { method: 'POST', path, headers: { ...json, ...headers }, body: submit });
    for (const res of [
      await post('/message', {}),
      await post('/message', bearer('wrong')),
      await post(`/message?token=${server.token}`, {}),
      await post(`/message?token=${server.token}`, bearer(server.token)),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(server.token);
      expect(JSON.stringify(res.headers)).not.toContain(server.token);
    }
    expect(fake.handled).toEqual([]);
    expect((await post('/message', bearer(server.token))).status).toBe(200);
  });

  it('generates a fresh 32-byte base64url token per server', async () => {
    const { server: a } = await start();
    const { server: b } = await start();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('uses a given token', async () => {
    const { server } = await start(fakeBridge(), { token: 'given-token' });
    expect(server.token).toBe('given-token');
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=given-token`);
  });
});

describe('/message', () => {
  async function post(server: WebServer, body: string | Buffer, headers: Record<string, string>) {
    return send(server.port, {
      method: 'POST',
      path: '/message',
      headers: { ...bearer(server.token), ...headers },
      body,
    });
  }

  it('refuses any content type but application/json', async () => {
    const { server, fake } = await start();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      expect((await post(server, submit, { 'Content-Type': type })).status).toBe(415);
    }
    expect((await post(server, submit, {})).status).toBe(415);
    expect(fake.handled).toEqual([]);
    const ok = await post(server, submit, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(ok.status).toBe(200);
  });

  it('answers invalid JSON and a protocol error with 400', async () => {
    const { server, fake } = await start();
    const bad = await post(server, '{nope', json);
    expect(bad.status).toBe(400);
    const wrong = await post(server, JSON.stringify({ type: 'submit', text: 3 }), json);
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body)).toEqual({ error: 'text must be a string' });
    expect(fake.handled).toEqual([]);
  });

  it('hands the bridge exactly the parsed message', async () => {
    const { server, fake } = await start();
    const res = await post(server, JSON.stringify({ type: 'submit', text: 'hi', extra: 1 }), json);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(fake.handled).toEqual([{ type: 'submit', text: 'hi' }]);
  });

  it('answers a conflict with 409 and another failure with 400', async () => {
    const { server, fake } = await start();
    fake.setResult({ ok: false, error: 'no open approval dialog d1', conflict: true });
    const conflict = await post(server, submit, json);
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ error: 'no open approval dialog d1' });
    fake.setResult({ ok: false, error: 'closed' });
    expect((await post(server, submit, json)).status).toBe(400);
  });

  // Keep-alive, as a browser sends: a client that asked for Connection: close is closed by Node
  // the moment the answer is out, and the unread upload turns that close into a reset.
  const keepAlive = { Connection: 'keep-alive' };

  it('refuses a body over the cap, declared or chunked, without calling the bridge', async () => {
    const { server, fake } = await start();
    const big = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 'a');
    expect((await post(server, big, { ...json, ...keepAlive })).status).toBe(413);
    const chunked = await send(server.port, {
      method: 'POST',
      path: '/message',
      headers: { ...bearer(server.token), ...json, ...keepAlive },
      body: Buffer.alloc(MAX_MESSAGE_BYTES * 2, 'a'),
      chunked: true,
    });
    expect(chunked.status).toBe(413);
    expect(fake.handled).toEqual([]);
  });

  it('keeps a connection usable after refusing a request that carried no body', async () => {
    const { server } = await start();
    const socket = connect(server.port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    await new Promise<void>(resolve => socket.once('connect', () => resolve()));
    socket.write('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n');
    await waitFor(() => received.includes('403'));
    // Past the grace a refused upload's socket is cut after.
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(socket.destroyed).toBe(false);
    received = '';
    socket.write(`GET /nothing HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    await waitFor(() => received.includes('404'));
    socket.destroy();
  });

  it('refuses an oversized Content-Length before any body arrives', async () => {
    const { server, fake } = await start();
    const res = await send(server.port, {
      method: 'POST',
      path: '/message',
      headers: {
        ...bearer(server.token),
        ...json,
        ...keepAlive,
        'Content-Length': String(MAX_MESSAGE_BYTES * 2),
      },
    });
    expect(res.status).toBe(413);
    expect(fake.handled).toEqual([]);
  });

  it('answers POST to any other path with 404', async () => {
    const { server } = await start();
    const res = await send(server.port, {
      method: 'POST',
      path: '/other',
      headers: { ...bearer(server.token), ...json },
      body: submit,
    });
    expect(res.status).toBe(404);
  });
});

const hello: ServerEvent = { type: 'hello', seq: 4, version: 1 };
const resolved: ServerEvent = { type: 'resolved', seq: 5, id: 'd1', outcome: 'answered' };
const delta: ServerEvent = { type: 'delta', channel: 'content', text: 'hi\nthere' };

function frames(text: string): string[] {
  return text.split('\n\n').filter(f => f !== '');
}

describe('/events', () => {
  it('sends the connect events in order, ids on committed events only', async () => {
    const { server } = await start(fakeBridge([hello, resolved, delta]));
    const s = await openStream(server.port, '/events', bearer(server.token));
    expect(s.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(s.headers['cache-control']).toBe('no-store');
    const text = await s.until(t => frames(t).length >= 3);
    expect(frames(text)).toEqual([
      `id: 4\ndata: ${JSON.stringify(hello)}`,
      `id: 5\ndata: ${JSON.stringify(resolved)}`,
      `data: ${JSON.stringify(delta)}`,
    ]);
    s.destroy();
  });

  it('reads the resume point from Last-Event-ID, else ?after=, ignoring junk', async () => {
    const { server, fake } = await start();
    const p = server.port;
    const t = server.token;
    const cases: [string, Record<string, string>][] = [
      [`/events?token=${t}`, {}],
      [`/events?token=${t}&after=12`, {}],
      [`/events?token=${t}&after=12`, { 'Last-Event-ID': '7' }],
      [`/events?token=${t}&after=-1`, {}],
      [`/events?token=${t}&after=1.5`, {}],
      [`/events?token=${t}`, { 'Last-Event-ID': 'abc' }],
    ];
    for (const [path, headers] of cases) {
      const s = await openStream(p, path, headers);
      s.destroy();
    }
    expect(fake.connectCalls).toEqual([undefined, 12, 7, undefined, undefined, undefined]);
  });

  it('delivers events pushed after connect, and unsubscribes on disconnect', async () => {
    const { server, fake } = await start();
    const s = await openStream(server.port, '/events', bearer(server.token));
    await waitFor(() => fake.listeners.size === 1);
    fake.push(resolved);
    const text = await s.until(t => t.includes('"resolved"'));
    expect(frames(text)).toEqual([`id: 5\ndata: ${JSON.stringify(resolved)}`]);
    s.destroy();
    await waitFor(() => fake.listeners.size === 0);
  });

  it('sends a heartbeat comment', async () => {
    const { server } = await start(fakeBridge(), { heartbeatMs: 20 });
    const s = await openStream(server.port, '/events', bearer(server.token));
    await s.until(t => t.includes(': ping\n\n'));
    s.destroy();
  });

  it('caps concurrent streams', async () => {
    const { server } = await start();
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      const s = await openStream(server.port, '/events', bearer(server.token));
      expect(s.status).toBe(200);
      open.push(s);
    }
    const extra = await send(server.port, { path: '/events', headers: bearer(server.token) });
    expect(extra.status).toBe(503);
    for (const s of open) s.destroy();
  });

  it('cuts a tab that stops reading', async () => {
    const { server, fake } = await start();
    const s = await openStream(server.port, '/events', bearer(server.token));
    await waitFor(() => fake.listeners.size === 1);
    s.response.pause();
    const big: ServerEvent = { type: 'delta', channel: 'content', text: 'x'.repeat(1024 * 1024) };
    for (let i = 0; i < 200 && fake.listeners.size > 0; i++) {
      fake.push(big);
      await new Promise(r => setImmediate(r));
    }
    expect(fake.listeners.size).toBe(0);
    s.destroy();
  });

  it('close() ends open streams and leaves the bridge open', async () => {
    const { server, fake } = await start(fakeBridge(), { heartbeatMs: 10 });
    const s = await openStream(server.port, '/events', bearer(server.token));
    await waitFor(() => fake.listeners.size === 1);
    await server.close();
    await s.ended;
    expect(fake.listeners.size).toBe(0);
    expect(fake.bridge.close).not.toHaveBeenCalled();
  });
});

describe('assets', () => {
  it('answers 404 with no hook', async () => {
    const { server } = await start();
    expect((await send(server.port, { path: '/index.html' })).status).toBe(404);
  });

  it('serves the hook body with every security header, no token needed', async () => {
    const assets = vi.fn(async (pathname: string) =>
      pathname === '/app.js' ? { body: 'console.log(1)', contentType: 'text/javascript' } : null,
    );
    const { server } = await start(fakeBridge(), { assets });
    const res = await send(server.port, { path: '/app.js?v=3' });
    expect(assets).toHaveBeenCalledWith('/app.js');
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['content-type']).toBe('text/javascript');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect((await send(server.port, { path: '/missing.js' })).status).toBe(404);
  });

  it('refuses dot segments, encoded dots, backslashes and NUL before the hook', async () => {
    const assets = vi.fn(async () => ({ body: 'secret', contentType: 'text/plain' }));
    const { server } = await start(fakeBridge(), { assets });
    for (const path of [
      '/../secret',
      '/a/../../secret',
      '/%2e%2e/secret',
      '/%2E%2E/secret',
      '/.%2e/secret',
      '/%252e%252e/secret',
      '/a\\..\\secret',
      '/a%5c..%5csecret',
      '/a%00.js',
      '/%zz',
    ]) {
      expect((await send(server.port, { path })).status, path).toBe(400);
    }
    expect(assets).not.toHaveBeenCalled();
  });

  it('answers a throwing hook with 500 and no detail', async () => {
    const assets = vi.fn(async () => {
      throw new Error('disk on fire at /repo/secret');
    });
    const { server } = await start(fakeBridge(), { assets });
    const res = await send(server.port, { path: '/index.html' });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('fire');
    expect(res.body).not.toContain('/repo');
  });
});

describe('no CORS', () => {
  it('has checked a response of every kind for Access-Control headers', () => {
    // Runs last in file order; each status here came through assertNoCorsHeaders.
    for (const status of [200, 400, 401, 403, 404, 405, 409, 413, 415, 500, 503]) {
      expect(seenStatuses.has(status), String(status)).toBe(true);
    }
  });
});
