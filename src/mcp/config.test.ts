import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMcpServers } from './config.js';

const dir = mkdtempSync(join(tmpdir(), 'reika-mcp-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseMcpServers', () => {
  it('is empty when unset', () => {
    expect(parseMcpServers(undefined)).toEqual({ servers: [], errors: [] });
    expect(parseMcpServers('   ')).toEqual({ servers: [], errors: [] });
  });

  it('reads the standard mcpServers wrapper, keyed by name', () => {
    const { servers, errors } = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', 'server-fs', '/tmp'] },
          github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 't' }, timeoutMs: 5000 },
        },
      }),
    );
    expect(errors).toEqual([]);
    expect(servers).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', 'server-fs', '/tmp'],
      },
      {
        name: 'github',
        command: 'gh-mcp',
        args: [],
        env: { GITHUB_TOKEN: 't' },
        timeoutMs: 5000,
      },
    ]);
  });

  it('reads a bare map and a list with per-entry names', () => {
    expect(parseMcpServers('{"a":{"command":"x"}}').servers).toEqual([
      { name: 'a', command: 'x', args: [] },
    ]);
    expect(parseMcpServers('[{"name":"a","command":"x","args":["1"]}]').servers).toEqual([
      { name: 'a', command: 'x', args: ['1'] },
    ]);
    // A list entry with no name still gets one, so `/mcp` can name it.
    expect(parseMcpServers('[{"command":"x"}]').servers[0].name).toBe('server1');
  });

  it('reads a path to a JSON file, expanding ~', () => {
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '{"mcpServers":{"s":{"command":"node","args":["s.js"]}}}');
    expect(parseMcpServers(file).servers).toEqual([{ name: 's', command: 'node', args: ['s.js'] }]);
  });

  it('reports an unreadable path and invalid JSON rather than throwing', () => {
    const missing = parseMcpServers(join(dir, 'nope.json'));
    expect(missing.servers).toEqual([]);
    expect(missing.errors[0]).toContain('cannot read');
    const bad = parseMcpServers('{not json');
    expect(bad.servers).toEqual([]);
    expect(bad.errors[0]).toContain('invalid JSON');
  });

  it('skips disabled entries and reports the rest, field by field', () => {
    const { servers, errors } = parseMcpServers(
      JSON.stringify({
        off: { command: 'x', disabled: true },
        broken: { command: '' },
        noargs: { command: 'x', args: 'not-a-list' },
        badenv: { command: 'x', env: { K: { nested: true } } },
        badtimeout: { command: 'x', timeoutMs: -1 },
        good: { command: 'x' },
      }),
    );
    expect(servers).toEqual([{ name: 'good', command: 'x', args: [] }]);
    expect(errors).toEqual([
      'MCP server "broken": needs a "command" string',
      'MCP server "noargs": "args" must be a list of strings',
      'MCP server "badenv": "env" value for K must be a string',
      'MCP server "badtimeout": "timeoutMs" must be a positive number of ms',
    ]);
  });

  it('reports a duplicate name once and keeps the first', () => {
    const { servers, errors } = parseMcpServers(
      '[{"name":"dup","command":"a"},{"name":"dup","command":"b"}]',
    );
    expect(servers.map(s => s.command)).toEqual(['a']);
    expect(errors).toEqual(['MCP server "dup": duplicate name']);
  });

  it('coerces numeric and boolean env values, the shape a JSON file often has', () => {
    expect(parseMcpServers('{"s":{"command":"x","env":{"N":3,"B":true}}}').servers[0].env).toEqual({
      N: '3',
      B: 'true',
    });
  });
});
