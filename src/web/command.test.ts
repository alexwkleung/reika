import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createSession, Session, SessionOptions, SubmitOptions } from '../session.js';
import type { Config, Message } from '../types.js';
import { parseWebArgs, runWeb, type WebHandle, type WebIo } from './command.js';
import { PROTOCOL_VERSION, type ServerEvent } from './protocol.js';

describe('parseWebArgs', () => {
  it('is null unless the first word is web', () => {
    expect(parseWebArgs([])).toBeNull();
    expect(parseWebArgs(['-p', 'web'])).toBeNull();
    expect(parseWebArgs(['--port', '80', 'web'])).toBeNull();
  });

  it('defaults to a free port', () => {
    expect(parseWebArgs(['web'])).toEqual({ port: 0, window: false, help: false });
  });

  it('takes --port and -h/--help', () => {
    expect(parseWebArgs(['web', '--port', '8080'])?.port).toBe(8080);
    expect(parseWebArgs(['web', '--port', '1'])?.port).toBe(1);
    expect(parseWebArgs(['web', '--port', '65535'])?.port).toBe(65535);
    expect(parseWebArgs(['web', '-h'])?.help).toBe(true);
    expect(parseWebArgs(['web', '--help'])?.help).toBe(true);
    expect(parseWebArgs(['web', '--window'])).toEqual({ port: 0, window: true, help: false });
  });

  it('refuses a bad port with the usage', () => {
    for (const bad of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '1.5']]) {
      expect(() => parseWebArgs(['web', ...bad])).toThrow(/--port needs[\s\S]*usage: reika web/);
    }
    expect(() => parseWebArgs(['web', '--port', '-1'])).toThrow(/--port needs/);
    expect(() => parseWebArgs(['web', '--port', 'abc'])).toThrow(/--port needs/);
  });

  it('refuses an unknown flag or argument', () => {
    expect(() => parseWebArgs(['web', '--windows'])).toThrow(/unexpected argument --windows/);
    expect(() => parseWebArgs(['web', 'extra'])).toThrow(/unexpected argument extra/);
  });
});

describe('import graph', () => {
  it('loads neither Ink nor React, nor any .tsx', async () => {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(import.meta.dirname, 'command.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      packages: 'external',
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter(f => f.endsWith('.tsx'))).toEqual([]);
    const externals = Object.values(result.metafile.inputs).flatMap(f =>
      f.imports.filter(i => i.external).map(i => i.path),
    );
    expect(externals.filter(p => /^(ink|react)(\/|$)/.test(p))).toEqual([]);
  });
});

let tmp: string;
let clientRoot: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'reika-web-'));
  clientRoot = join(tmp, 'client');
  await mkdir(clientRoot);
  await writeFile(join(clientRoot, 'index.html'), '<!doctype html><title>client</title>');
  await writeFile(join(clientRoot, 'app.js'), 'export {};');
  await writeFile(join(clientRoot, 'app.css'), ':root{}');
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const profile = { model: 'local', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' };
// No `autosave`, so nothing is written under the home directory.
const config = {
  autoApprove: 'off',
  models: ['local'],
  profiles: { default: profile },
} as unknown as Config;

function fakeSession(cfg: Config) {
  const session = {
    profile: 'default',
    bundle: { cwd: '/repo/app', skills: [], fileIndex: [] },
    config: { ...cfg, model: 'local' },
    shrink: { sheds: 0, folds: 0 },
    offline: false,
    mcpNotices: [] as string[],
    getSnapshot: () => ({ config: cfg }),
    subscribe: () => () => {},
    submit: vi.fn(async (text: string, opts: SubmitOptions): Promise<Message[]> => {
      opts.onTurnStart?.();
      const bubble: Message = { role: 'user', content: opts.display ?? text };
      opts.events?.onMessage?.(bubble);
      opts.onTurnEnd?.();
      return [bubble];
    }),
    mcp: { call: vi.fn(), commands: [], list: vi.fn(() => ''), close: vi.fn(async () => {}) },
    updateBundle: vi.fn(),
    switchSide: vi.fn(),
    loadHistory: vi.fn(),
    reset: vi.fn(),
    addProfile: vi.fn(),
    setProfile: vi.fn(async () => []),
  };
  return session;
}

function ioWith(overrides: Partial<WebIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let made: ReturnType<typeof fakeSession> | null = null;
  const create = vi.fn(async (o: SessionOptions) => {
    made = fakeSession(o.config ?? config);
    return made as unknown as Session;
  });
  const io: WebIo = {
    stdout: t => void out.push(t),
    stderr: t => void err.push(t),
    cwd: '/repo/app',
    loadConfig: () => config,
    loadLastState: () => ({}),
    saveLastState: vi.fn(),
    defaultMode: () => 'agent',
    createSession: create as unknown as typeof createSession,
    clientRoot,
    ...overrides,
  };
  return { io, out, err, session: () => made! };
}

const handles: WebHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(h => h.shutdown()));
});

// What the page does with a link: trade its single-use code for the token.
async function tradeLink(link: string): Promise<string> {
  const url = new URL(link);
  const res = await fetch(`${url.origin}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.origin },
    body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get('code') }),
  });
  if (!res.ok) throw new Error(`link refused: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function start(overrides: Partial<WebIo> = {}, window = false) {
  const t = ioWith(overrides);
  const run = await runWeb({ port: 0, window, help: false }, t.io);
  if (typeof run === 'number') throw new Error(`runWeb failed: ${t.err.join('')}`);
  handles.push(run);
  return { ...t, run, token: window ? '' : await tradeLink(run.url) };
}

// A window that never launches anything: records the link it was handed and ends when told.
function fakeWindow(kind: 'app' | 'tab' = 'app') {
  const opened: string[] = [];
  let end!: (outcome: 'closed' | 'failed') => void;
  const ended = new Promise<'closed' | 'failed'>(r => (end = r));
  const close = vi.fn(async () => end('closed'));
  const codeSpent = vi.fn(async () => {});
  const openWindow: WebIo['openWindow'] = async link => {
    opened.push(link);
    return kind === 'app'
      ? { kind, browser: 'Google Chrome', ended, codeSpent, close }
      : { kind, reason: 'no Chrome found', codeSpent, close };
  };
  return { opened, end, close, codeSpent, openWindow };
}

// A page's event stream, held open until closed: what a window or tab is to the server.
function holdStream(port: number, token: string): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/events',
        headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
      },
      res => {
        res.resume();
        resolve({ close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const fastWindow = { windowTimings: { signInMs: 60_000, pageGoneMs: 80 } };
const settled = (run: WebHandle) =>
  Promise.race([
    run.done.then(() => 'stopped'),
    new Promise(r => setTimeout(() => r('running'), 300)),
  ]);

type Reply = { status: number; headers: Record<string, unknown>; body: string };

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, token: string, value: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/message',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => (text += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Reads SSE frames until `until` is satisfied, then drops the connection.
function readEvents(
  port: number,
  token: string,
  until: (events: ServerEvent[]) => boolean,
): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/events',
        headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
      },
      res => {
        const events: ServerEvent[] = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = frame
              .split('\n')
              .find(l => l.startsWith('data: '))
              ?.slice(6);
            if (data) events.push(JSON.parse(data) as ServerEvent);
          }
          if (until(events)) {
            req.destroy();
            resolve(events);
          }
        });
      },
    );
    req.on('error', e => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function portRefuses(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

describe('runWeb', () => {
  it('prints a single-use link, never the token, and says only this machine can connect', async () => {
    const { run, out, token } = await start();
    const text = out.join('');
    expect(text).toContain(run.url);
    expect(run.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${run.port}/#code=[\\w-]+$`));
    expect(text).not.toContain(token);
    expect(text).toMatch(/Only this machine/);
    expect(text).toMatch(/ctrl-c to stop/);
  });

  it('hands out a fresh link on request, and the printed one works only once', async () => {
    const { run } = await start();
    // `start` already traded the printed link.
    await expect(tradeLink(run.url)).rejects.toThrow('401');
    const next = run.newLink();
    expect(next).not.toBe(run.url);
    expect(await tradeLink(next)).toBeTruthy();
  });

  it('serves the built client, and says how to build a missing one', async () => {
    const built = await start();
    const index = await get(built.run.port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body).toContain('<title>client</title>');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.headers['referrer-policy']).toBe('no-referrer');
    expect((await get(built.run.port, '/app.js')).headers['content-type']).toMatch(/javascript/);
    expect((await get(built.run.port, '/app.css')).headers['content-type']).toMatch(/text\/css/);
    expect((await get(built.run.port, '/client.js')).status).toBe(404);
    expect((await get(built.run.port, '/package.json')).status).toBe(404);

    const missing = await start({ clientRoot: join(clientRoot, 'nope') });
    const page = await get(missing.run.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.body).toContain('pnpm run build:web');
  });

  it('streams a hello and a snapshot, and a POSTed submit reaches the turn', async () => {
    const { run, token, session } = await start();
    const first = await readEvents(run.port, token, e => e.some(x => x.type === 'live'));
    expect(first[0]).toMatchObject({ type: 'hello', version: PROTOCOL_VERSION });
    expect(first.map(e => e.type)).toEqual([
      'hello',
      'reset',
      'state',
      'catalog',
      'history',
      'live',
    ]);

    const reply = await post(run.port, token, { type: 'submit', text: 'hello there' });
    expect(reply.status).toBe(200);
    await vi.waitFor(() => expect(session().submit).toHaveBeenCalled());
    expect(session().submit.mock.calls[0][0]).toContain('hello there');
  });

  it('shuts down once: the port closes, MCP is closed and done resolves', async () => {
    const { run, session } = await start();
    await run.shutdown(130);
    await run.shutdown(0);
    expect(await run.done).toBe(130);
    expect(session().mcp.close).toHaveBeenCalledTimes(1);
    expect(await portRefuses(run.port)).toBe(true);
  });

  it('shuts down on a tab /exit', async () => {
    const { run, token } = await start();
    expect((await post(run.port, token, { type: 'submit', text: '/exit' })).status).toBe(200);
    expect(await run.done).toBe(0);
  });

  it('returns 1 with the reason on stderr when boot fails, and listens on nothing', async () => {
    const t = ioWith({
      loadConfig: () => {
        throw new Error('REIKA_MODEL is not set');
      },
    });
    const port = await freePort();
    const run = await runWeb({ port, window: false, help: false }, t.io);
    expect(run).toBe(1);
    expect(t.err.join('')).toContain('REIKA_MODEL is not set');
    expect(t.out).toEqual([]);
    expect(await portRefuses(port)).toBe(true);
  });
});

describe('runWeb --window', () => {
  it('hands the window the first link and prints no link of its own', async () => {
    const w = fakeWindow();
    const { run, out } = await start({ openWindow: w.openWindow }, true);
    expect(w.opened).toEqual([run.url]);
    const text = out.join('');
    expect(text).not.toContain('#code=');
    expect(text).toMatch(/Opened an app window in Google Chrome; closing it stops reika/);
    expect(await tradeLink(w.opened[0])).toBeTruthy();
  });

  it('stops when the window is closed before it ever connected', async () => {
    const w = fakeWindow();
    const { run, session, out } = await start({ openWindow: w.openWindow }, true);
    w.end('closed');
    expect(await run.done).toBe(0);
    expect(out.join('')).toContain('The window closed; stopping.');
    expect(session().mcp.close).toHaveBeenCalledTimes(1);
    expect(await portRefuses(run.port)).toBe(true);
  });

  it('keeps running and prints a fresh link when the window fails to open', async () => {
    const w = fakeWindow();
    const { run, out } = await start({ openWindow: w.openWindow }, true);
    w.end('failed');
    await vi.waitFor(() => expect(out.join('')).toMatch(/closed as soon as it opened/));
    const link = out.join('').match(/http:\/\/\S+#code=[\w-]+/)?.[0];
    expect(link).toBeTruthy();
    expect(await tradeLink(link!)).toBeTruthy();
    expect(await portRefuses(run.port)).toBe(false);
  });

  it('closes the window on shutdown', async () => {
    const w = fakeWindow();
    const { run } = await start({ openWindow: w.openWindow }, true);
    await run.shutdown(130);
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(await run.done).toBe(130);
  });

  it('says why it opened a tab instead', async () => {
    const w = fakeWindow('tab');
    const { out } = await start({ openWindow: w.openWindow }, true);
    expect(out.join('')).toMatch(/Opened a tab in the default browser \(no Chrome found\)/);
  });

  it('prints a link when the window cannot be opened at all', async () => {
    const { out, err } = await start(
      {
        openWindow: async () => {
          throw new Error('every window profile is in use');
        },
      },
      true,
    );
    expect(err.join('')).toContain('could not open a window: every window profile is in use');
    expect(out.join('')).toMatch(/#code=/);
  });

  it('marks the code spent when the window signs in', async () => {
    const w = fakeWindow();
    await start({ openWindow: w.openWindow }, true);
    expect(w.codeSpent).not.toHaveBeenCalled();
    await tradeLink(w.opened[0]);
    expect(w.codeSpent).toHaveBeenCalledTimes(1);
  });

  it('offers a link when the window has not signed in in time, and not when it has', async () => {
    const slow = fakeWindow();
    const late = await start(
      { openWindow: slow.openWindow, windowTimings: { signInMs: 50 } },
      true,
    );
    await vi.waitFor(() => expect(late.out.join('')).toMatch(/has not signed in yet/));
    const link = late.out.join('').match(/http:\/\/\S+#code=[\w-]+/)?.[0];
    expect(await tradeLink(link!)).toBeTruthy();

    const quick = fakeWindow();
    const ok = await start(
      { openWindow: quick.openWindow, windowTimings: { signInMs: 100 } },
      true,
    );
    await tradeLink(quick.opened[0]);
    await new Promise(r => setTimeout(r, 200));
    expect(ok.out.join('')).not.toMatch(/has not signed in/);
  });

  it('stops once no page is connected, and outlives a reload', async () => {
    const w = fakeWindow();
    const { run, out } = await start({ openWindow: w.openWindow, ...fastWindow }, true);
    const token = await tradeLink(w.opened[0]);
    const first = await holdStream(run.port, token);
    first.close();
    // A reload: the page is back well inside the wait.
    const again = await holdStream(run.port, token);
    expect(await settled(run)).toBe('running');
    again.close();
    expect(await run.done).toBe(0);
    expect(out.join('')).toContain('The window closed; stopping.');
    expect(w.close).toHaveBeenCalled();
  });

  it('keeps running while a second tab is open after the window closes', async () => {
    const w = fakeWindow();
    const { run } = await start({ openWindow: w.openWindow, ...fastWindow }, true);
    const token = await tradeLink(w.opened[0]);
    const windowPage = await holdStream(run.port, token);
    const tab = await holdStream(run.port, token);
    windowPage.close();
    w.end('closed');
    expect(await settled(run)).toBe('running');
    tab.close();
    expect(await run.done).toBe(0);
  });

  it('never stops on its own without --window', async () => {
    const { run, token } = await start({ ...fastWindow });
    const page = await holdStream(run.port, token);
    page.close();
    expect(await settled(run)).toBe('running');
  });
});
