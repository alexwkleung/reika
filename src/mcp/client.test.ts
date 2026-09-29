import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MODERN_PROTOCOL_VERSION, McpClient, serverEnv } from './client.js';
import { DEFAULT_TIMEOUT_MS, type McpServerConfig } from './config.js';

// A real stdio MCP server, spawned from this test: the transport (framing, handshake, pagination,
// a server-initiated request, a crash) is the part worth testing, and a stub transport would test
// the stub. Written into a temp dir rather than committed, so nothing test-only lives in src/.
const dir = mkdtempSync(join(tmpdir(), 'reika-mcp-client-'));
const serverPath = join(dir, 'server.mjs');
writeFileSync(
  serverPath,
  `
let buf = '';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
if (process.env.FIXTURE_BANNER === '1') process.stdout.write('starting up\\n');
let pendingCall = null;
let collideCall = null;
const cancelled = [];
const replies = {};
const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask', description: 'Asks the client for things', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exits the process', inputSchema: { type: 'object', properties: {} } },
];
const handle = msg => {
  if (collideCall !== null && msg.id === collideCall && msg.method === undefined) {
    send({ jsonrpc: '2.0', id: collideCall, result: { content: [{ type: 'text', text: 'after ping' }] } });
    collideCall = null;
    return;
  }
  if (msg.method === 'notifications/cancelled') { cancelled.push(msg.params); return; }
  if (msg.method === 'server/discover' && process.env.FIXTURE_SILENT_PROBE === '1') return;
  if (msg.id === 'r1' || msg.id === 'r2') {
    replies[msg.id] = msg;
    if (replies.r1 && replies.r2 && pendingCall !== null) {
      send({ jsonrpc: '2.0', id: pendingCall, result: { content: [{ type: 'text', text: JSON.stringify([replies.r1, replies.r2]) }] } });
      pendingCall = null;
    }
    return;
  }
  if (msg.method === 'initialize') {
    const reply = () => send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.2.3' }, instructions: 'fixture instructions' } });
    // A server that takes its time introducing itself, which a cold \`npx\` install does: the bound
    // under test is the handshake's own (McpServerConfig.connectTimeoutMs).
    const delay = Number(process.env.FIXTURE_INIT_DELAY || 0) || 0;
    if (delay > 0) setTimeout(reply, delay);
    else reply();
    return;
  }
  if (msg.method === 'notifications/initialized') {
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    if (msg.params && msg.params.cursor === 'page2') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'extra', description: 'Second page', inputSchema: { type: 'object', properties: {} } }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS, nextCursor: 'page2' } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params.name;
    const args = msg.params.arguments || {};
    if (name === 'echo') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + args.text }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }], structuredContent: { ok: true } } }); return; }
    if (name === 'fail') { send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'boom\\nsecond line' }] } }); return; }
    if (name === 'slow') return;
    if (name === 'ask') { pendingCall = msg.id; send({ jsonrpc: '2.0', id: 'r1', method: 'roots/list', params: {} }); send({ jsonrpc: '2.0', id: 'r2', method: 'sampling/createMessage', params: {} }); return; }
    if (name === 'crash') { process.exit(3); }
    // The server's own request, numbered like the call it arrives during — what a server counting
    // its requests from 1 does. The call is answered only after reika answers the ping.
    if (name === 'collide') { collideCall = msg.id; send({ jsonrpc: '2.0', id: msg.id, method: 'ping' }); return; }
    if (name === 'env') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env)) }] } }); return; }
    if (name === 'cancelled') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(cancelled) }] } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }  // What both SDKs' legacy servers do with an unknown method — including reika's server/discover
  // probe, which this answer is what makes fast.
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`,
);

// A 2026-07-28 server that speaks nothing older: no `initialize`, `_meta` on every request, and
// `input_required` results. The era a new SDK's server defaults to.
const modernPath = join(dir, 'modern.mjs');
writeFileSync(
  modernPath,
  `
let buf = '';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
const seen = [];
const META = 'io.modelcontextprotocol/protocolVersion';
const text = (id, t) => send({ jsonrpc: '2.0', id, result: { resultType: 'complete', content: [{ type: 'text', text: t }] } });
const handle = msg => {
  if (msg.method) seen.push(msg.method);
  if (msg.method === 'server/discover') {
    if (process.env.FIXTURE_REJECT_VERSION === '1') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2027-01-01'], requested: msg.params._meta[META] } } });
      return;
    }
    const reply = () => send({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern', version: '2.0' } }, instructions: 'modern instructions', ttlMs: 0, cacheScope: 'private' } });
    const delay = Number(process.env.FIXTURE_DISCOVER_DELAY || 0) || 0;
    if (delay > 0) setTimeout(reply, delay);
    else reply();
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize' || !msg.params || !msg.params._meta || msg.params._meta[META] !== '2026-07-28') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'initialize is not supported; this server speaks 2026-07-28' } });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', tools: [{ name: 'meta', inputSchema: { type: 'object', properties: {} } }], ttlMs: 0, cacheScope: 'private' } });
    return;
  }
  if (msg.method === 'tools/call') {
    const p = msg.params;
    if (p.name === 'meta') return text(msg.id, JSON.stringify({ meta: p._meta, seen }));
    if (p.name === 'stateful') {
      if (p.requestState === 's1') return text(msg.id, 'done with s1');
      send({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'input_required', requestState: 's1' } });
      return;
    }
    if (p.name === 'elicit') {
      send({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'input_required', inputRequests: { login: { method: 'elicitation/create', params: {} } } } });
      return;
    }
    if (p.name === 'forever') {
      send({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'input_required', requestState: 'again' } });
      return;
    }
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`,
);

const clients: McpClient[] = [];
function makeClient(
  over: Partial<McpServerConfig> = {},
  opts: { probeWaitMs?: number } = {},
): McpClient {
  const client = new McpClient(
    {
      name: 'fixture',
      command: process.execPath,
      args: [serverPath],
      ...over,
    },
    opts,
  );
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('McpClient', () => {
  it('handshakes and lists every page of tools', async () => {
    const client = makeClient({ env: { FIXTURE_BANNER: '1' } });
    await client.connect();
    expect(client.server).toEqual({
      name: 'fixture',
      version: '1.2.3',
      instructions: 'fixture instructions',
      protocol: '2025-06-18',
    });
    // The banner line is not JSON: dropped, not fatal. The second page is fetched by cursor, and
    // the notification sent before tools/list is recorded.
    expect(client.tools.map(t => t.name)).toEqual([
      'echo',
      'fail',
      'slow',
      'ask',
      'crash',
      'extra',
    ]);
    expect(client.tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(client.toolsChanged).toBe(true);
  });

  it('calls a tool and passes the result through', async () => {
    const client = makeClient();
    await client.connect();
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.content?.[0]).toEqual({ type: 'text', text: 'echo: hi' });
    expect(result.structuredContent).toEqual({ ok: true });
    // A tool-level failure is a successful call with isError — not an exception.
    const failed = await client.callTool('fail', {});
    expect(failed.isError).toBe(true);
  });

  it('rejects a JSON-RPC error with the server’s own message', async () => {
    const client = makeClient();
    await client.connect();
    await expect(client.callTool('nope', {})).rejects.toThrow('unknown tool (-32602)');
  });

  it('times a call out rather than hanging, and stays usable after', async () => {
    const client = makeClient({ timeoutMs: 150 });
    await client.connect();
    await expect(client.callTool('slow', {})).rejects.toThrow(
      /no answer to tools\/call after 150ms/,
    );
    expect((await client.callTool('echo', { text: 'again' })).content?.[0]).toEqual({
      type: 'text',
      text: 'echo: again',
    });
  });

  it('answers a server-initiated request: roots with an empty list, anything else with -32601', async () => {
    const client = makeClient();
    await client.connect();
    const result = await client.callTool('ask', {});
    const replies = JSON.parse(String((result.content?.[0] as { text: string }).text)) as {
      id: string;
      result?: unknown;
      error?: { code: number };
    }[];
    expect(replies.find(r => r.id === 'r1')?.result).toEqual({ roots: [] });
    expect(replies.find(r => r.id === 'r2')?.error?.code).toBe(-32601);
  });

  it('fails a call when the server dies, with the exit status', async () => {
    const client = makeClient();
    await client.connect();
    await expect(client.callTool('crash', {})).rejects.toThrow(/server exited \(code 3\)/);
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/server exited/);
  });

  it('reports a command that cannot start, and a server that exits during the handshake', async () => {
    const missing = new McpClient({
      name: 'missing',
      command: 'reika-no-such-binary-xyz',
      args: [],
    });
    clients.push(missing);
    await expect(missing.connect()).rejects.toThrow(/could not start reika-no-such-binary-xyz/);

    const quitting = new McpClient({
      name: 'quitting',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    clients.push(quitting);
    await expect(quitting.connect()).rejects.toThrow(/server exited \(code 0\)/);
  });

  it('rejects a call on a client whose server never started, naming the command', async () => {
    const client = makeClient({ command: process.execPath, args: [join(dir, 'not-a-server.mjs')] });
    await expect(client.connect()).rejects.toThrow(/server exited/);
  });

  // The handshake's bound is the server's own, not the per-call one and not a fixed 15s: a server
  // behind a cold `npx` install can need longer to say hello while its calls are quick, and a
  // generous call timeout has no business turning a startup hang into a minute of no first frame.
  it('honours a per-server handshake bound, and the default rejects the same delay', async () => {
    const impatient = makeClient({ env: { FIXTURE_INIT_DELAY: '400' }, connectTimeoutMs: 80 });
    await expect(impatient.connect()).rejects.toThrow(/no answer to initialize after 80ms/);

    const patient = makeClient({ env: { FIXTURE_INIT_DELAY: '400' }, connectTimeoutMs: 5000 });
    await patient.connect();
    expect(patient.tools.map(t => t.name)).toContain('echo');
  });

  it('aborts a call when the turn is aborted', async () => {
    const client = makeClient({ timeoutMs: DEFAULT_TIMEOUT_MS });
    await client.connect();
    const controller = new AbortController();
    const call = client.callTool('slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow('aborted');
  });

  // Matching a reply on id alone let this ping resolve the pending call with `undefined`: the call's
  // real answer was then dropped as a late reply to a finished request.
  it('does not take a server request for the reply to a call with the same id', async () => {
    const client = makeClient();
    await client.connect();
    expect((await client.callTool('collide', {})).content?.[0]).toEqual({
      type: 'text',
      text: 'after ping',
    });
  });

  it('tells the server when a call is abandoned, on abort and on timeout', async () => {
    const client = makeClient();
    await client.connect();
    const controller = new AbortController();
    const aborted = client.callTool('slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow('aborted');
    await expect(client.callTool('slow', {}, { timeoutMs: 50 })).rejects.toThrow(/after 50ms/);
    const log = await client.callTool('cancelled', {});
    const notices = JSON.parse(String((log.content?.[0] as { text: string }).text)) as {
      requestId: unknown;
      reason: string;
    }[];
    expect(notices.map(n => n.reason)).toEqual(['aborted by the user', 'timed out']);
    expect(notices.every(n => typeof n.requestId === 'number')).toBe(true);
  });

  it("passes a server only a safe slice of reika's environment, plus its own env", async () => {
    process.env.REIKA_MCP_TEST_SECRET = 'not for servers';
    try {
      const client = makeClient({ env: { FIXTURE_EXTRA: '1' } });
      await client.connect();
      const out = await client.callTool('env', {});
      const keys = JSON.parse(String((out.content?.[0] as { text: string }).text)) as string[];
      expect(keys).toContain('PATH');
      expect(keys).toContain('FIXTURE_EXTRA');
      expect(keys).not.toContain('REIKA_MCP_TEST_SECRET');
    } finally {
      delete process.env.REIKA_MCP_TEST_SECRET;
    }
  });

  it('leaves exported shell functions behind', () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '() { echo hi; }';
    try {
      expect(serverEnv(undefined).SHELL).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });

  it('falls back to initialize when a legacy server ignores the probe', async () => {
    const client = makeClient({ env: { FIXTURE_SILENT_PROBE: '1' } }, { probeWaitMs: 50 });
    await client.connect();
    expect(client.server.protocol).toBe('2025-06-18');
    expect(client.tools.map(t => t.name)).toContain('echo');
  });
});

describe('McpClient against a 2026-07-28 server', () => {
  const modern = (env: Record<string, string> = {}, probeWaitMs?: number): McpClient =>
    makeClient({ args: [modernPath], env }, probeWaitMs === undefined ? {} : { probeWaitMs });

  it('discovers instead of initializing, and carries _meta on every request', async () => {
    const client = modern();
    await client.connect();
    expect(client.server).toEqual({
      name: 'modern',
      version: '2.0',
      instructions: 'modern instructions',
      protocol: MODERN_PROTOCOL_VERSION,
    });
    const out = await client.callTool('meta', {});
    const { meta, seen } = JSON.parse(String((out.content?.[0] as { text: string }).text)) as {
      meta: Record<string, unknown>;
      seen: string[];
    };
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(MODERN_PROTOCOL_VERSION);
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
    expect(meta['io.modelcontextprotocol/clientInfo']).toMatchObject({ name: 'reika' });
    expect(seen).toEqual(['server/discover', 'tools/list', 'tools/call']);
  });

  it('connects to a modern server that answers the probe late, after initialize was rejected', async () => {
    const client = modern({ FIXTURE_DISCOVER_DELAY: '300' }, 50);
    await client.connect();
    expect(client.server.protocol).toBe(MODERN_PROTOCOL_VERSION);
  });

  it('names both sides when the server supports none of our versions', async () => {
    const client = modern({ FIXTURE_REJECT_VERSION: '1' });
    await expect(client.connect()).rejects.toThrow(
      /server speaks protocol 2027-01-01; reika speaks 2026-07-28/,
    );
  });

  it('retries an input_required result that only carries state, echoing the state', async () => {
    const client = modern();
    await client.connect();
    expect((await client.callTool('stateful', {})).content?.[0]).toEqual({
      type: 'text',
      text: 'done with s1',
    });
  });

  it('fails a call that asks for input, and one that never stops asking', async () => {
    const client = modern();
    await client.connect();
    await expect(client.callTool('elicit', {})).rejects.toThrow(
      /asked for input reika cannot give \(elicitation\/create\)/,
    );
    await expect(client.callTool('forever', {})).rejects.toThrow(/called again 4 times/);
  });
});
