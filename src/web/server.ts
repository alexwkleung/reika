import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebBridge } from './bridge.js';
import { MAX_IMAGE_BYTES, parseClientMessage, UPLOAD_TYPES, type ServerEvent } from './protocol.js';

// The HTTP layer of the web front end (#584/#595): bridge events out to tabs over SSE, a tab's
// messages in over POST. Whoever passes these checks can drive the agent, so each one is a rule.

export const MAX_STREAMS = 32;
export const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const TOKEN_BYTES = 32;
export const LINK_CODE_TTL_MS = 10 * 60_000;
const BAD_CODE_ERROR = 'invalid or expired link code';
// Bounds on the request side only, so a slow-loris cannot hold sockets; an SSE response is not
// governed by either once its GET has arrived.
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
const REFUSED_UPLOAD_GRACE_MS = 1000;

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export type WebAsset = { body: string | Uint8Array; contentType: string };

export type WebServerOptions = {
  port?: number;
  token?: string;
  assets?: (pathname: string) => Promise<WebAsset | null>;
  heartbeatMs?: number;
  now?: () => number;
  // For `reika web --window`, which must know when its window has signed in and when no page is
  // left: a link's code was traded, and the number of open event streams changed.
  onLinkSpent?: () => void;
  onStreamCount?: (count: number) => void;
};

export type WebServer = {
  port: number;
  token: string;
  url: string;
  newLink(): string;
  close(): Promise<void>;
};

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

// Hashed first so both sides are 32 bytes: timingSafeEqual needs equal lengths, and comparing
// lengths directly would leak the token's.
function tokenMatches(candidate: string | undefined, expectedHash: Buffer): boolean {
  if (candidate === undefined) return false;
  return timingSafeEqual(sha256(candidate), expectedHash);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1] : undefined;
}

// Node keeps the first of a repeated Host and drops the rest, so a second, different value
// would go unread; a request naming more than one is refused instead.
function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

function setBaseHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  // A page that opened this one keeps no handle to it, now that a cross-site load of `/` is
  // admitted.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

// `complete` is false inside the handler even for a request with no body, so it cannot be the
// test alone: a body Node can drain within the cap is left to it, and the connection stays usable.
function unboundedBodyPending(req: IncomingMessage): boolean {
  if (req.complete) return false;
  if (req.headers['transfer-encoding'] !== undefined) return true;
  return !(Number(req.headers['content-length'] ?? 0) <= MAX_MESSAGE_BYTES);
}

function finish(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  // Node would otherwise drain an unread body on finish, reading whatever a refused client keeps
  // sending. read(0) marks it consumed, the pause stops it, and the socket is cut after a grace
  // that lets the client read this answer before the reset.
  if (unboundedBodyPending(req)) {
    req.read(0);
    req.pause();
    res.end(body, () => {
      setTimeout(() => req.socket.destroy(), REFUSED_UPLOAD_GRACE_MS).unref();
    });
    return;
  }
  res.end(body);
}

function sendText(req: IncomingMessage, res: ServerResponse, status: number, text: string): void {
  finish(req, res, status, 'text/plain; charset=utf-8', text);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  finish(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function parseResumePoint(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

// Checked on the raw target, because the URL parser resolves `..`, `%2e%2e` and `\` before a
// caller could see them. A `%` left after one decode is refused so a hook that decodes again
// cannot be handed a `..`.
function safeAssetPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  for (const text of [rawPath, decoded]) {
    if (text.includes('\0') || text.includes('\\') || text.split('/').includes('..')) return null;
  }
  if (decoded.includes('%')) return null;
  return decoded;
}

function eventFrame(event: ServerEvent): string {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  return 'seq' in event ? `id: ${event.seq}\n${data}` : data;
}

// Not `for await`: leaving that loop early destroys the socket, and the 413 could not be sent.
function readBody(req: IncomingMessage, limit = MAX_MESSAGE_BYTES): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        req.off('data', onData);
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
    req.once('close', () => reject(new Error('request closed')));
  });
}

export async function startWebServer(
  bridge: WebBridge,
  opts: WebServerOptions = {},
): Promise<WebServer> {
  const token = opts.token ?? randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = sha256(token);
  // A digest of nothing anyone holds, compared against when no code is live, so a dead code costs
  // the same comparison as a live one.
  const noCodeHash = sha256(randomBytes(TOKEN_BYTES).toString('base64url'));
  let liveCode: { hash: Buffer; mintedAt: number } | null = null;
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const streams = new Set<{ res: ServerResponse; stop: () => void }>();
  let port = 0;

  // A hook is the caller's code running inside a request: its failure must not cost the request.
  function notify<A extends unknown[]>(hook: ((...args: A) => void) | undefined, ...args: A): void {
    try {
      hook?.(...args);
    } catch {}
  }

  function allowedHosts(): string[] {
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  }

  // Exact match, case included: a browser sends the host as the user typed the page's own URL,
  // which this server wrote lowercase, and anything else is not that page.
  function passesOriginChecks(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (headerCount(req, 'host') !== 1 || typeof host !== 'string') return false;
    if (!allowedHosts().includes(host)) return false;
    const originCount = headerCount(req, 'origin');
    if (originCount > 1) return false;
    if (originCount === 1) {
      const origin = req.headers.origin;
      if (!allowedHosts().some(h => origin === `http://${h}`)) return false;
    }
    const siteCount = headerCount(req, 'sec-fetch-site');
    if (siteCount > 1) return false;
    if (siteCount === 1) {
      const site = req.headers['sec-fetch-site'];
      const pageLoad = site === 'cross-site' && isPageLoad(req);
      if (site !== 'same-origin' && site !== 'none' && !pageLoad) return false;
    }
    return true;
  }

  // The page itself, loaded as a window's top-level document, cross-site: `reika web --window`
  // opens it through a local file that redirects (the link must not sit in a command line), which
  // a browser labels cross-site. Not same-site, which would only add the other localhost ports. Any site could already link the user here, and the bare page
  // does nothing without the code in its fragment, which no linking site holds. A frame is
  // `iframe`, not `document`, and stays refused; the API and the other files keep the strict rule.
  function isPageLoad(req: IncomingMessage): boolean {
    return (
      req.method === 'GET' &&
      req.url === '/' &&
      headerCount(req, 'sec-fetch-mode') === 1 &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      headerCount(req, 'sec-fetch-dest') === 1 &&
      req.headers['sec-fetch-dest'] === 'document'
    );
  }

  // In the fragment, so the code never reaches a request line or a Referer, and a speculative
  // fetch of the pasted URL cannot spend it.
  function newLink(): string {
    const code = randomBytes(TOKEN_BYTES).toString('base64url');
    liveCode = { hash: sha256(code), mintedAt: now() };
    return `http://127.0.0.1:${port}/#code=${code}`;
  }

  function consumeLinkCode(candidate: unknown): boolean {
    const live =
      liveCode !== null && now() - liveCode.mintedAt < LINK_CODE_TTL_MS ? liveCode : null;
    if (live === null) liveCode = null;
    const code = typeof candidate === 'string' ? candidate : undefined;
    const matched = tokenMatches(code ?? '', live?.hash ?? noCodeHash) && live !== null && !!code;
    if (matched) {
      liveCode = null;
      notify(opts.onLinkSpent);
    }
    return matched;
  }

  function openStream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    // A token in a URL is the leak the link code exists to end, so its presence refuses outright.
    if (query.has('token') || !tokenMatches(bearerToken(req), tokenHash)) {
      sendText(req, res, 401, 'unauthorized');
      return;
    }
    if (streams.size >= MAX_STREAMS) {
      sendText(req, res, 503, 'too many streams');
      return;
    }
    const lastEventId = req.headers['last-event-id'];
    const after =
      typeof lastEventId === 'string'
        ? parseResumePoint(lastEventId)
        : parseResumePoint(query.get('after'));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // The snapshot goes out whole, since the bridge already holds it; after it, a tab whose
    // backlog passes the cap has stopped reading and is cut (it reconnects and resumes).
    const write = (frame: string): void => {
      if (res.destroyed) return;
      if (res.writableLength > MAX_STREAM_BUFFER_BYTES) {
        res.destroy();
        return;
      }
      res.write(frame);
    };

    const snapshot = bridge.connect(after);
    res.write(snapshot.map(eventFrame).join(''));
    // Same tick as connect, so no event can land between the snapshot and the subscription.
    const unsubscribe = bridge.subscribe(event => write(eventFrame(event)));
    const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();

    const entry = {
      res,
      stop: () => {
        clearInterval(heartbeat);
        unsubscribe();
        if (streams.delete(entry)) notify(opts.onStreamCount, streams.size);
      },
    };
    streams.add(entry);
    notify(opts.onStreamCount, streams.size);
    res.on('close', entry.stop);
    if (res.destroyed) entry.stop();
  }

  async function acceptMessage(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    // The header only: a token in a POST's URL is one a cross-site form could be pointed at.
    if (query.has('token') || !tokenMatches(bearerToken(req), tokenHash)) {
      sendText(req, res, 401, 'unauthorized');
      return;
    }
    const value = await readJsonBody(req, res);
    if (value === undefined) return;
    const message = parseClientMessage(value);
    if ('error' in message) {
      sendJson(req, res, 400, { error: message.error });
      return;
    }
    const result = await bridge.handle(message);
    if (result.ok) {
      sendJson(req, res, 200, 'reply' in result ? { ok: true, reply: result.reply } : { ok: true });
    } else sendJson(req, res, result.conflict ? 409 : 400, { error: result.error });
  }

  // An image's raw bytes (#979): token-only like /message, and a type no cross-site form or
  // no-cors fetch can send without the preflight that is refused.
  async function acceptUpload(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    if (query.has('token') || !tokenMatches(bearerToken(req), tokenHash)) {
      sendText(req, res, 401, 'unauthorized');
      return;
    }
    const contentType = req.headers['content-type'];
    const mediaType =
      typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
    if (!(UPLOAD_TYPES as readonly string[]).includes(mediaType)) {
      sendText(req, res, 415, 'unsupported media type');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(Number(declared) <= MAX_IMAGE_BYTES)) {
      sendText(req, res, 413, 'payload too large');
      return;
    }
    // Before the read: a refused upload must not buffer its bytes first.
    const refused = bridge.uploadRefusal();
    if (refused) {
      sendJson(req, res, refused.status, { error: refused.error });
      return;
    }
    const body = await readBody(req, MAX_IMAGE_BYTES);
    if (body === 'too-large') {
      sendText(req, res, 413, 'payload too large');
      return;
    }
    const result = await bridge.upload(body, mediaType);
    // The tab that sent it is gone and will never name the id: nobody else can.
    if (result.ok && (res.destroyed || req.socket.destroyed)) {
      await bridge.handle({ type: 'discard', ids: [result.reply.id] });
      return;
    }
    if (result.ok) sendJson(req, res, 200, { ok: true, reply: result.reply });
    else sendJson(req, res, result.status, { error: result.error });
  }

  // The one route that hands out the token, so the one that never takes a credential in its URL
  // and answers every failed code alike.
  async function exchangeLinkCode(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    if (query.has('code') || query.has('token')) {
      sendJson(req, res, 401, { error: BAD_CODE_ERROR });
      return;
    }
    // The page's own fetch POST always sends Origin (checked exact above), so a caller without
    // one is not the page.
    if (headerCount(req, 'origin') !== 1) {
      sendText(req, res, 403, 'forbidden');
      return;
    }
    const value = await readJsonBody(req, res);
    if (value === undefined) return;
    const code =
      typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined;
    if (consumeLinkCode(code)) sendJson(req, res, 200, { token });
    else sendJson(req, res, 401, { error: BAD_CODE_ERROR });
  }

  // Answers the refusal itself and returns undefined, or returns the parsed body.
  async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    // A form on another site cannot send application/json without a preflight, which is refused.
    const contentType = req.headers['content-type'];
    const mediaType =
      typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
    if (mediaType !== 'application/json') {
      sendText(req, res, 415, 'unsupported media type');
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(Number(declared) <= MAX_MESSAGE_BYTES)) {
      sendText(req, res, 413, 'payload too large');
      return;
    }
    const body = await readBody(req);
    if (body === 'too-large') {
      sendText(req, res, 413, 'payload too large');
      return;
    }
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(req, res, 400, { error: 'invalid JSON' });
      return undefined;
    }
  }

  async function serveAsset(req: IncomingMessage, res: ServerResponse, rawPath: string) {
    const pathname = safeAssetPath(rawPath);
    if (pathname === null) {
      sendText(req, res, 400, 'bad path');
      return;
    }
    const asset = opts.assets ? await opts.assets(pathname) : null;
    if (!asset) {
      sendText(req, res, 404, 'not found');
      return;
    }
    finish(req, res, 200, asset.contentType, asset.body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setBaseHeaders(res);
    if (!passesOriginChecks(req)) {
      sendText(req, res, 403, 'forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendText(req, res, 405, 'method not allowed');
      return;
    }
    const target = req.url ?? '';
    if (!target.startsWith('/')) {
      sendText(req, res, 400, 'bad request');
      return;
    }
    const queryAt = target.indexOf('?');
    const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1));
    if (req.method === 'POST') {
      if (rawPath === '/message') await acceptMessage(req, res, query);
      else if (rawPath === '/upload') await acceptUpload(req, res, query);
      else if (rawPath === '/session') await exchangeLinkCode(req, res, query);
      else sendText(req, res, 404, 'not found');
      return;
    }
    if (rawPath === '/events') openStream(req, res, query);
    else await serveAsset(req, res, rawPath);
  }

  // Off so a request with no Host reaches the check below and gets its 403, not Node's own 400.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    route(req, res).catch(() => {
      try {
        if (!res.headersSent) sendText(req, res, 500, 'internal error');
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    token,
    url: newLink(),
    newLink,
    close: () =>
      new Promise<void>(resolve => {
        for (const stream of [...streams]) {
          stream.stop();
          stream.res.end();
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
