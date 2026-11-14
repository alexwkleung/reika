import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createSession, Session, SessionOptions, SubmitOptions } from '../session.js';
import type { Config, Message } from '../types.js';
import { parseWebArgs, runWeb, type WebHandle, type WebIo } from './command.js';
import type { ServerEvent } from './protocol.js';

describe('parseWebArgs', () => {
  it('is null unless the first word is web', () => {
    expect(parseWebArgs([])).toBeNull();
    expect(parseWebArgs(['-p', 'web'])).toBeNull();
    expect(parseWebArgs(['--port', '80', 'web'])).toBeNull();
  });

  it('defaults to a free port', () => {
    expect(parseWebArgs(['web'])).toEqual({ port: 0, help: false });
  });

  it('takes --port and -h/--help', () => {
    expect(parseWebArgs(['web', '--port', '8080'])?.port).toBe(8080);
    expect(parseWebArgs(['web', '--port', '1'])?.port).toBe(1);
    expect(parseWebArgs(['web', '--port', '65535'])?.port).toBe(65535);
    expect(parseWebArgs(['web', '-h'])?.help).toBe(true);
    expect(parseWebArgs(['web', '--help'])?.help).toBe(true);
  });

  it('refuses a bad port with the usage', () => {
    for (const bad of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '1.5']]) {
      expect(() => parseWebArgs(['web', ...bad])).toThrow(/--port needs[\s\S]*usage: reika web/);
    }
    expect(() => parseWebArgs(['web', '--port', '-1'])).toThrow(/--port needs/);
    expect(() => parseWebArgs(['web', '--port', 'abc'])).toThrow(/--port needs/);
  });

  it('refuses an unknown flag or argument', () => {
    expect(() => parseWebArgs(['web', '--window'])).toThrow(/unexpected argument --window/);
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

let assetsRoot: string;
beforeAll(async () => {
  assetsRoot = await mkdtemp(join(tmpdir(), 'reika-web-'));
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>proof</title>');
  await writeFile(join(assetsRoot, 'client.js'), 'void 0;');
  await writeFile(join(assetsRoot, 'style.css'), 'body{}');
});
afterAll(async () => {
  await rm(assetsRoot, { recursive: true, force: true });
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
    assetsRoot,
    ...overrides,
  };
  return { io, out, err, session: () => made! };
}

const handles: WebHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(h => h.shutdown()));
});

async function start(overrides: Partial<WebIo> = {}) {
  const t = ioWith(overrides);
  const run = await runWeb({ port: 0, help: false }, t.io);
  if (typeof run === 'number') throw new Error(`runWeb failed: ${t.err.join('')}`);
  handles.push(run);
  const token = new URL(run.url).searchParams.get('token')!;
  return { ...t, run, token };
}

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
        path: `/events?token=${token}`,
        headers: { Host: `127.0.0.1:${port}` },
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
  it('prints the URL with its token and says it serves only this machine', async () => {
    const { run, out, token } = await start();
    const text = out.join('');
    expect(text).toContain(run.url);
    expect(run.url).toBe(`http://127.0.0.1:${run.port}/?token=${token}`);
    expect(text).toMatch(/only this machine/);
    expect(text).toMatch(/ctrl-c to stop/);
  });

  it('serves the proof client', async () => {
    const { run, token } = await start();
    const index = await get(run.port, `/?token=${token}`);
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.body).toContain('<title>proof</title>');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.headers['referrer-policy']).toBe('no-referrer');
    expect((await get(run.port, '/client.js')).headers['content-type']).toMatch(/javascript/);
    expect((await get(run.port, '/style.css')).headers['content-type']).toMatch(/text\/css/);
    expect((await get(run.port, '/package.json')).status).toBe(404);
  });

  it('streams a hello and a snapshot, and a POSTed submit reaches the turn', async () => {
    const { run, token, session } = await start();
    const first = await readEvents(run.port, token, e => e.some(x => x.type === 'live'));
    expect(first[0]).toMatchObject({ type: 'hello', version: 1 });
    expect(first.map(e => e.type)).toEqual(['hello', 'reset', 'state', 'live']);

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
    const run = await runWeb({ port, help: false }, t.io);
    expect(run).toBe(1);
    expect(t.err.join('')).toContain('REIKA_MODEL is not set');
    expect(t.out).toEqual([]);
    expect(await portRefuses(port)).toBe(true);
  });
});
