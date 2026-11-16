import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, Server as NetServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { HandleResult, UploadResult, WebBridge } from './bridge.js';
import { MAX_IMAGE_BYTES, type ClientMessage, type ServerEvent } from './protocol.js';
import {
  LINK_CODE_TTL_MS,
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
  let result: HandleResult | Promise<HandleResult> = { ok: true };
  const uploaded: { bytes: Uint8Array; type: string }[] = [];
  let uploadResult: UploadResult = { ok: true, reply: { id: 'u1', chars: 12 } };
  let refusal: Extract<UploadResult, { ok: false }> | null = null;
  const bridge: WebBridge = {
    uploadRefusal: () => refusal,
    async upload(bytes, type) {
      uploaded.push({ bytes, type });
      return uploadResult;
    },
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
    setResult(next: HandleResult | Promise<HandleResult>) {
      result = next;
    },
    uploaded,
    setUploadResult(next: UploadResult) {
      uploadResult = next;
    },
    setUploadRefusal(next: Extract<UploadResult, { ok: false }> | null) {
      refusal = next;
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

// Every token and code the suite is handed, and every response it sees, so the last test can
// check where each came back.
const tokens = new Set<string>();
const codes = new Set<string>();
type Seen = { path: string; status: number; headers: IncomingHttpHeaders; body: () => string };
const seenResponses: Seen[] = [];

async function start(fake = fakeBridge(), opts: WebServerOptions = {}) {
  const server = await startWebServer(fake.bridge, opts);
  servers.push(server);
  tokens.add(server.token);
  codes.add(codeOf(server.url));
  const newLink = server.newLink.bind(server);
  server.newLink = () => {
    const link = newLink();
    codes.add(codeOf(link));
    return link;
  };
  return { server, fake };
}

function codeOf(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get('code') ?? '';
}

// Every response the suite sees goes through here, so the no-CORS rule is asserted on all of them.
const seenStatuses = new Set<number>();
function assertNoCorsHeaders(headers: IncomingHttpHeaders, status: number): void {
  seenStatuses.add(status);
  expect(Object.keys(headers).filter(k => k.startsWith('access-control-'))).toEqual([]);
  expect(headers['set-cookie']).toBeUndefined();
}

type Req = {
  method?: string;
  path?: string;
  // `null` sends no Host at all.
  host?: string | null;
  // A list sends the header once per value.
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  // Sends the body without a Content-Length.
  chunked?: boolean;
};

type Res = { status: number; headers: IncomingHttpHeaders; body: string };

function send(port: number, req: Req = {}): Promise<Res> {
  const headers: Record<string, string | string[]> = { ...req.headers };
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
        seenResponses.push({
          path: req.path ?? '/',
          status: answered.status,
          headers: res.headers,
          body: () => answered.body,
        });
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
        seenResponses.push({
          path,
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: () => text,
        });
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
    expect(server.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/#code=`));
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

describe('window hooks', () => {
  it('says when a link is spent, once, and counts open streams', async () => {
    const spent = vi.fn();
    const counts: number[] = [];
    const { server } = await start(fakeBridge(), {
      onLinkSpent: spent,
      onStreamCount: n => counts.push(n),
    });
    const code = new URLSearchParams(server.url.split('#')[1]).get('code');
    const exchange = (value: unknown) =>
      send(server.port, {
        method: 'POST',
        path: '/session',
        headers: { ...json, Origin: `http://127.0.0.1:${server.port}` },
        body: JSON.stringify({ code: value }),
      });
    expect((await exchange('wrong')).status).toBe(401);
    expect(spent).not.toHaveBeenCalled();
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(401);
    expect(spent).toHaveBeenCalledTimes(1);

    const a = await openStream(server.port, '/events', bearer(server.token));
    const b = await openStream(server.port, '/events', bearer(server.token));
    await waitFor(() => counts.length === 2);
    a.destroy();
    b.destroy();
    await waitFor(() => counts.length === 4);
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it('keeps serving when a hook throws', async () => {
    const { server } = await start(fakeBridge(), {
      onStreamCount: () => {
        throw new Error('boom');
      },
    });
    const s = await openStream(server.port, '/events', bearer(server.token));
    expect(s.status).toBe(200);
    s.destroy();
  });
});

describe('a cross-site page load', () => {
  const navigate = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };

  it('admits the page itself, loaded as a top-level document', async () => {
    const { server } = await start();
    // No assets in these tests: past the checks, the page is a 404.
    const page = await send(server.port, { headers: navigate });
    expect(page.status).toBe(404);
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('refuses it framed, fetched, for another path, with a query, or as a POST', async () => {
    const { server, fake } = await start();
    const p = server.port;
    const refused = [
      { headers: { ...navigate, 'Sec-Fetch-Dest': 'iframe' } },
      { headers: { ...navigate, 'Sec-Fetch-Mode': 'cors' } },
      { headers: { ...navigate, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' } },
      { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } },
      { path: '/app.js', headers: navigate },
      { path: '/events', headers: navigate },
      { path: '/?code=x', headers: navigate },
      { path: '/?', headers: navigate },
      { path: '//', headers: navigate },
      { path: `http://127.0.0.1:${p}/`, headers: navigate },
      { method: 'HEAD', headers: navigate },
      // Another localhost port is same-site, and not the redirect file this exists for.
      { headers: { ...navigate, 'Sec-Fetch-Site': 'same-site' } },
      { method: 'POST', path: '/session', headers: { ...navigate, ...json }, body: '{"code":"x"}' },
      {
        method: 'POST',
        path: '/message',
        headers: { ...navigate, ...json, ...bearer(server.token) },
        body: submit,
      },
    ];
    for (const r of refused) expect((await send(p, r)).status).toBe(403);
    expect(fake.handled).toEqual([]);
  });

  it('refuses a doubled mode or dest header', async () => {
    const { server } = await start();
    const doubled = (name: string, value: string) =>
      send(server.port, {
        headers: { ...navigate, [name]: [navigate[name as keyof typeof navigate], value] },
      });
    expect((await doubled('Sec-Fetch-Dest', 'iframe')).status).toBe(403);
    expect((await doubled('Sec-Fetch-Mode', 'cors')).status).toBe(403);
  });

  it('still checks the host and the origin', async () => {
    const { server } = await start();
    const p = server.port;
    expect((await send(p, { host: `evil.example:${p}`, headers: navigate })).status).toBe(403);
    expect(
      (await send(p, { headers: { ...navigate, Origin: 'http://evil.example' } })).status,
    ).toBe(403);
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
  it('gates /events: none, wrong, wrong-length and any query token refused; Bearer admitted', async () => {
    const { server } = await start();
    const p = server.port;
    for (const path of [
      '/events',
      '/events?token=wrong',
      `/events?token=${server.token}x`,
      `/events?token=${server.token}`,
    ]) {
      const res = await send(p, { path });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(server.token);
    }
    expect((await send(p, { path: '/events', headers: bearer('nope') })).status).toBe(401);
    const byHeader = await openStream(p, '/events', bearer(server.token));
    expect(byHeader.status).toBe(200);
    byHeader.destroy();
  });

  it('refuses ?token= on /events even beside a valid Bearer header', async () => {
    const { server } = await start();
    for (const token of [server.token, 'x']) {
      const res = await send(server.port, {
        path: `/events?token=${token}`,
        headers: bearer(server.token),
      });
      expect(res.status).toBe(401);
    }
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
    expect(server.url).not.toContain('given-token');
  });
});

describe('link code', () => {
  const origin = (server: WebServer) => ({ Origin: `http://127.0.0.1:${server.port}` });
  function exchange(
    server: WebServer,
    body: unknown,
    headers: Record<string, string> = { ...json, ...origin(server) },
    path = '/session',
  ) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    return send(server.port, { method: 'POST', path, headers, body: raw });
  }
  const refused = { error: 'invalid or expired link code' };

  async function expectStillLive(server: WebServer, code: string) {
    expect((await exchange(server, { code })).status).toBe(200);
  }

  it('hands out a #code= link that is not the token, and voids the last one', async () => {
    const { server } = await start();
    const first = codeOf(server.url);
    const link = server.newLink();
    expect(link).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/#code=[A-Za-z0-9_-]{43}$`),
    );
    expect(link).not.toContain(server.token);
    expect(server.url).not.toContain(server.token);
    expect(codeOf(link)).not.toBe(first);
    const old = await exchange(server, { code: first });
    expect(old.status).toBe(401);
    expect(JSON.parse(old.body)).toEqual(refused);
    await expectStillLive(server, codeOf(link));
  });

  it('trades a good code for the token, which then opens /events and posts', async () => {
    const { server, fake } = await start(fakeBridge([hello]));
    const res = await exchange(server, { code: codeOf(server.url) });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const { token } = JSON.parse(res.body) as { token: string };
    expect(token).toBe(server.token);
    const s = await openStream(server.port, '/events', bearer(token));
    expect(s.status).toBe(200);
    await s.until(t => t.includes('"hello"'));
    s.destroy();
    const post = await send(server.port, {
      method: 'POST',
      path: '/message',
      headers: { ...json, ...bearer(token) },
      body: submit,
    });
    expect(post.status).toBe(200);
    expect(fake.handled).toEqual([{ type: 'submit', text: 'hi' }]);
  });

  it('answers used, wrong, empty, non-string and missing codes with one 401', async () => {
    const { server } = await start();
    const code = codeOf(server.url);
    expect((await exchange(server, { code })).status).toBe(200);
    for (const body of [
      { code },
      { code: 'wrong' },
      { code: `${code}x` },
      { code: '' },
      { code: 3 },
      { code: [code] },
      {},
      null,
      [code],
      JSON.stringify(code),
    ]) {
      const res = await exchange(server, body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(JSON.parse(res.body)).toEqual(refused);
    }
  });

  it('answers malformed JSON with 400 and leaves the code live', async () => {
    const { server } = await start();
    const res = await exchange(server, '{nope');
    expect(res.status).toBe(400);
    await expectStillLive(server, codeOf(server.url));
  });

  it('expires a code LINK_CODE_TTL_MS after it was minted', async () => {
    let clock = 1_000_000;
    const { server } = await start(fakeBridge(), { now: () => clock });
    const fresh = server.newLink();
    clock += LINK_CODE_TTL_MS - 1;
    expect((await exchange(server, { code: codeOf(fresh) })).status).toBe(200);
    const late = server.newLink();
    clock += LINK_CODE_TTL_MS;
    const res = await exchange(server, { code: codeOf(late) });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(refused);
  });

  it('refuses no Origin, a foreign one or cross-site with 403, keeping the code', async () => {
    const { server } = await start();
    const code = codeOf(server.url);
    for (const headers of <Record<string, string>[]>[
      { ...json },
      { ...json, 'Sec-Fetch-Site': 'same-origin' },
      { ...json, Origin: 'http://evil.example' },
      { ...json, Origin: `http://127.0.0.1:${server.port + 1}` },
      { ...json, ...origin(server), 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const res = await exchange(server, { code }, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body).not.toContain(server.token);
    }
    await expectStillLive(server, code);
  });

  it('refuses a wrong content type with 415 and an over-cap body with 413, keeping the code', async () => {
    const { server } = await start();
    const code = codeOf(server.url);
    const asText = await exchange(
      server,
      { code },
      { ...origin(server), 'Content-Type': 'text/plain' },
    );
    expect(asText.status).toBe(415);
    const big = await exchange(server, Buffer.alloc(MAX_MESSAGE_BYTES + 1, 'a'), {
      ...json,
      ...origin(server),
      Connection: 'keep-alive',
    });
    expect(big.status).toBe(413);
    await expectStillLive(server, code);
  });

  it('refuses a code or token in the /session query with 401', async () => {
    const { server } = await start();
    const code = codeOf(server.url);
    for (const path of [
      `/session?code=${code}`,
      `/session?token=${server.token}`,
      '/session?code=',
    ]) {
      const res = await exchange(server, { code }, undefined, path);
      expect(res.status, path).toBe(401);
      expect(JSON.parse(res.body)).toEqual(refused);
    }
    await expectStillLive(server, code);
  });

  it('does not exchange on GET /session or GET /?code=', async () => {
    const { server } = await start();
    const code = codeOf(server.url);
    // Both are asset paths, and this server has no asset hook.
    expect((await send(server.port, { path: '/session' })).status).toBe(404);
    expect((await send(server.port, { path: `/session?code=${code}` })).status).toBe(404);
    const root = await send(server.port, { path: `/?code=${code}` });
    expect(root.status).toBe(404);
    expect(root.body).not.toContain(server.token);
    await expectStillLive(server, code);
  });
});

describe('/upload (#979)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const up = (server: WebServer, req: Req = {}) =>
    send(server.port, {
      method: 'POST',
      path: '/upload',
      body: png,
      ...req,
      headers: { ...bearer(server.token), 'Content-Type': 'image/png', ...req.headers },
    });

  it('takes the token in the header only', async () => {
    const { server, fake } = await start();
    expect((await up(server, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await up(server, { path: `/upload?token=${server.token}` })).status).toBe(401);
    expect(fake.uploaded).toEqual([]);
  });

  it('refuses every type but the image types', async () => {
    const { server, fake } = await start();
    for (const type of ['application/json', 'text/plain', 'multipart/form-data', 'image/svg+xml']) {
      expect((await up(server, { headers: { 'Content-Type': type } })).status).toBe(415);
    }
    expect(fake.uploaded).toEqual([]);
  });

  it('refuses a body past the image cap while reading it', async () => {
    const { server, fake } = await start();
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    expect((await up(server, { body: big, chunked: true })).status).toBe(413);
    expect(fake.uploaded).toEqual([]);
  });

  it('answers a refusal the bridge knows before reading the bytes', async () => {
    const { server, fake } = await start();
    fake.setUploadRefusal({ ok: false, error: 'another image is still being read', status: 429 });
    const res = await up(server);
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'another image is still being read' });
    expect(fake.uploaded).toEqual([]);
  });

  it('hands the bridge the bytes and type, and sends its answer back', async () => {
    const { server, fake } = await start();
    const res = await up(server, { headers: { 'Content-Type': 'image/png; charset=binary' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, reply: { id: 'u1', chars: 12 } });
    expect(Buffer.from(fake.uploaded[0].bytes)).toEqual(png);
    expect(fake.uploaded[0].type).toBe('image/png');
    fake.setUploadResult({ ok: false, error: 'too many', status: 429 });
    const refused = await up(server);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ error: 'too many' });
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

  it('sends a reply in the body, null included', async () => {
    const { server, fake } = await start();
    const complete = JSON.stringify({ type: 'complete', text: '/mo' });
    const reply = {
      kind: 'command' as const,
      partial: '/mo',
      items: [{ value: '/model', display: '/model' }],
    };
    fake.setResult({ ok: true, reply });
    expect(JSON.parse((await post(server, complete, json)).body)).toEqual({ ok: true, reply });
    fake.setResult({ ok: true, reply: null });
    expect(JSON.parse((await post(server, complete, json)).body)).toEqual({
      ok: true,
      reply: null,
    });
  });

  it('waits for a reply the bridge answers in a promise', async () => {
    const { server, fake } = await start();
    const reply = { scope: 'project' as const, entries: [], total: 0, autosave: true };
    fake.setResult(new Promise(resolve => setTimeout(() => resolve({ ok: true, reply }), 20)));
    const sessions = JSON.stringify({ type: 'sessions', scope: 'project' });
    expect(JSON.parse((await post(server, sessions, json)).body)).toEqual({ ok: true, reply });
    fake.setResult(Promise.resolve({ ok: false, error: 'busy', conflict: true }));
    expect((await post(server, sessions, json)).status).toBe(409);
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
    const cases: [string, Record<string, string>][] = [
      ['/events', {}],
      ['/events?after=12', {}],
      ['/events?after=12', { 'Last-Event-ID': '7' }],
      ['/events?after=-1', {}],
      ['/events?after=1.5', {}],
      ['/events', { 'Last-Event-ID': 'abc' }],
    ];
    for (const [path, headers] of cases) {
      const s = await openStream(p, path, { ...bearer(server.token), ...headers });
      s.destroy();
    }
    expect(fake.connectCalls).toEqual([undefined, 12, 7, undefined, undefined, undefined]);
  });

  it('streams to a fetch reader that sets Authorization and Last-Event-ID itself', async () => {
    const { server, fake } = await start(fakeBridge([hello]));
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
      headers: { ...bearer(server.token), 'Last-Event-ID': '3' },
      signal: abort.signal,
    });
    assertNoCorsHeaders(Object.fromEntries(res.headers), res.status);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes('\n\n')) text += (await reader.read()).value ?? '';
    expect(frames(text)).toEqual([`id: 4\ndata: ${JSON.stringify(hello)}`]);
    expect(fake.connectCalls).toEqual([3]);
    abort.abort();
    await reader.cancel().catch(() => {});
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
      "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

describe('secrets', () => {
  it('sends the token only in a /session 200 body, and a code in no response at all', () => {
    // Runs last in file order, over every response the suite saw.
    expect(tokens.size).toBeGreaterThan(10);
    expect(codes.size).toBeGreaterThan(10);
    expect(seenResponses.length).toBeGreaterThan(50);
    let tokenBodies = 0;
    for (const { path, status, headers, body } of seenResponses) {
      const head = JSON.stringify(headers);
      const text = body();
      const exchanged = path === '/session' && status === 200;
      for (const token of tokens) {
        expect(head.includes(token), token).toBe(false);
        if (text.includes(token)) {
          expect(exchanged, `${status} ${path}`).toBe(true);
          tokenBodies++;
        }
      }
      for (const code of codes) expect((head + text).includes(code), code).toBe(false);
    }
    expect(tokenBodies).toBeGreaterThan(0);
  });
});
