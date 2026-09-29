import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServerConfig } from './config.js';
import { connectMcpServers } from './manager.js';

// A second real server, smaller than client.test.ts's: the manager's job is the wiring — namespaced
// tools, command spellings, notices, call routing — and that wiring is only exercised end to end.
const dir = mkdtempSync(join(tmpdir(), 'reika-mcp-manager-'));
const serverPath = join(dir, 'server.mjs');
writeFileSync(
  serverPath,
  `
let buf = '';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
const handle = msg => {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture-server', version: '0.1' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    if (process.env.FIXTURE_ANNOUNCE === '1') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'Strange.Name', description: 'Odd name', inputSchema: { type: 'object', properties: {} } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    // A server that dies mid-session, so the manager's liveness read-through has something to see.
    if (msg.params.name === 'crash') process.exit(9);
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok:' + (msg.params.arguments || {}).text }] } });
    // After the handshake and after the manager built its statuses: the timing a real server uses.
    if (process.env.FIXTURE_ANNOUNCE_LATE === '1') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
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
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function server(name: string, env: Record<string, string> = {}): McpServerConfig {
  return { name, command: process.execPath, args: [serverPath], env };
}

describe('connectMcpServers', () => {
  it('says nothing at all when nothing is configured', async () => {
    const runtime = await connectMcpServers([]);
    expect(runtime.tools).toEqual([]);
    expect(runtime.notices).toEqual([]);
    expect(runtime.list()).toContain('No MCP servers configured');
    await expect(runtime.call('x', 'y', {})).rejects.toThrow('no MCP server "x"');
  });

  it('namespaces the tools, spells the commands, and reports what connected', async () => {
    const runtime = await connectMcpServers([server('gh')]);
    try {
      expect(runtime.tools.map(t => t.name)).toEqual(['mcp__gh__echo', 'mcp__gh__Strange_Name']);
      expect(runtime.commands.map(c => c.name)).toEqual(['gh:echo', 'gh:strange.name']);
      expect(runtime.notices).toEqual([
        'MCP: gh (2 tools) — 2 tools added in agent mode. /mcp lists them.',
      ]);
      const list = runtime.list();
      expect(list).toContain('MCP: 1 server, 2 tools');
      expect(list).toContain('gh — 2 tools (fixture-server 0.1, MCP 2025-06-18)');
      expect(list).toContain('/gh:echo');
    } finally {
      runtime.close();
    }
  });

  it('keeps a broken server out of the tool list and says why', async () => {
    const runtime = await connectMcpServers([
      server('good'),
      { name: 'broken', command: 'reika-no-such-binary-xyz', args: [] },
    ]);
    try {
      expect(runtime.tools.map(t => t.name)).toEqual([
        'mcp__good__echo',
        'mcp__good__Strange_Name',
      ]);
      expect(runtime.notices[0]).toContain('MCP: good (2 tools)');
      expect(runtime.notices[1]).toContain('MCP server "broken" unavailable');
      expect(runtime.notices[1]).toContain('could not start reika-no-such-binary-xyz');
      expect(runtime.list()).toContain('broken — unavailable:');
    } finally {
      runtime.close();
    }
  });

  it('routes a call to the named server, and reports a tool list changed during the handshake', async () => {
    const runtime = await connectMcpServers([server('good', { FIXTURE_ANNOUNCE: '1' })]);
    try {
      const result = await runtime.call('good', 'echo', { text: 'hi' });
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok:hi' });
      await expect(runtime.call('other', 'echo', {})).rejects.toThrow('no MCP server "other"');
      expect(runtime.servers[0].changed).toBe(true);
      expect(runtime.list()).toContain('restart reika to pick it up');
    } finally {
      runtime.close();
    }
  });

  // A server announces a changed tool list when its tools change, which is after startup — the
  // handshake case above is inside `connect()` and passes on a status copy too, so this is the
  // timing that pins the status reading through to the client.
  it('reports a tool list changed after the session started', async () => {
    const runtime = await connectMcpServers([server('good', { FIXTURE_ANNOUNCE_LATE: '1' })]);
    try {
      expect(runtime.servers[0].changed).toBe(false);
      expect(runtime.list()).not.toContain('restart reika to pick it up');
      await runtime.call('good', 'echo', { text: 'hi' });
      // The notification rides the reply, so it reaches the client's stdout parser a tick later.
      for (let i = 0; i < 100 && !runtime.servers[0].changed; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
      expect(runtime.servers[0].changed).toBe(true);
      expect(runtime.list()).toContain('restart reika to pick it up');
    } finally {
      runtime.close();
    }
  });

  it('closes every server it started', async () => {
    const runtime = await connectMcpServers([server('one'), server('two')]);
    runtime.close();
    await expect(runtime.call('one', 'echo', {})).rejects.toThrow(/closed|server exited/);
    await expect(runtime.call('two', 'echo', {})).rejects.toThrow(/closed|server exited/);
  });

  // The other staleness the startup snapshot cannot see: a server that exits after connecting. Its
  // tools stay in the request's tool list (that list is fixed at session start), so `/mcp` is the
  // only place a call that fails on every round gets explained (#265 review).
  it('reports a server that exits after the session started', async () => {
    const runtime = await connectMcpServers([server('good')]);
    try {
      expect(runtime.servers[0].dead).toBe(false);
      expect(runtime.list()).not.toContain('has exited');
      await expect(runtime.call('good', 'crash', {})).rejects.toThrow(/server exited \(code 9\)/);
      expect(runtime.servers[0].dead).toBe(true);
      expect(runtime.list()).toContain('this server has exited');
    } finally {
      runtime.close();
    }
  });
});
