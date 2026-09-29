import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { McpClient } from './client.js';
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
const replies = {};
const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
  { name: 'ask', description: 'Asks the client for things', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exits the process', inputSchema: { type: 'object', properties: {} } },
];
const handle = msg => {
  if (msg.id === 'r1' || msg.id === 'r2') {
    replies[msg.id] = msg;
    if (replies.r1 && replies.r2 && pendingCall !== null) {
      send({ jsonrpc: '2.0', id: pendingCall, result: { content: [{ type: 'text', text: JSON.stringify([replies.r1, replies.r2]) }] } });
      pendingCall = null;
    }
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.2.3' }, instructions: 'fixture instructions' } });
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
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }
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
function makeClient(over: Partial<McpServerConfig> = {}): McpClient {
  const client = new McpClient({
    name: 'fixture',
    command: process.execPath,
    args: [serverPath],
    ...over,
  });
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

  it('aborts a call when the turn is aborted', async () => {
    const client = makeClient({ timeoutMs: DEFAULT_TIMEOUT_MS });
    await client.connect();
    const controller = new AbortController();
    const call = client.callTool('slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow('aborted');
  });
});
