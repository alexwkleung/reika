import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types.js';
import type { McpContentBlock } from './client.js';
import {
  capMcpPayload,
  callMcpTool,
  findMcpCommand,
  formatMcpResult,
  invokeMcpTool,
  mcpCommandName,
  mcpCommands,
  mcpTool,
  mcpToolName,
  parseMcpArgs,
  schemaToParameters,
} from './tools.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ cwd: '/tmp', ...over });
const never = (): Promise<never> => Promise.reject(new Error('should not be called'));

describe('mcpToolName', () => {
  it('namespaces the server and the tool', () => {
    expect(mcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('slugs characters a provider would reject', () => {
    expect(mcpToolName('my server', 'read.file!')).toBe('mcp__my_server__read_file');
    expect(mcpToolName('--', 'x')).toBe('mcp__server__x');
  });

  it('caps the length and stays unique when it truncates', () => {
    const long = 'x'.repeat(80);
    const a = mcpToolName('srv', long);
    const b = mcpToolName('srv', `${long}y`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(mcpToolName('srv', 'short').length).toBeLessThanOrEqual(64);
  });
});

describe('mcpCommands', () => {
  it('lowercases the command name and takes the first line of the description', () => {
    const [cmd] = mcpCommands('FileSystem', [
      {
        name: 'ReadFile',
        description: 'Read a file.\nMore detail nobody needs in a list.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]);
    expect(cmd.name).toBe('filesystem:readfile');
    expect(cmd.description).toBe('Read a file.');
    expect(cmd.server).toBe('FileSystem');
    expect(cmd.tool).toBe('ReadFile');
    expect(mcpCommandName('a b', 'c')).toBe('a-b:c');
  });
});

describe('schemaToParameters', () => {
  it('keeps only what a provider accepts, defaulting an absent schema to no arguments', () => {
    expect(schemaToParameters(undefined)).toEqual({ type: 'object', properties: {} });
    expect(
      schemaToParameters({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { a: { type: 'string' }, b: { $ref: '#/$defs/x' } },
        required: ['a', 7, 'b'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { $ref: '#/$defs/x' } },
      required: ['a', 'b'],
    });
  });

  it('omits an empty required list', () => {
    expect(schemaToParameters({ type: 'object', properties: {}, required: [] })).toEqual({
      type: 'object',
      properties: {},
    });
  });

  // The properties can `$ref` into the definition maps, so narrowing the top level while dropping
  // them leaves a reference nothing can resolve (#265 review). Both spellings travel.
  it('carries the definition maps a $ref points at', () => {
    expect(
      schemaToParameters({
        type: 'object',
        properties: { p: { $ref: '#/$defs/P' } },
        $defs: { P: { type: 'string' } },
        definitions: { Q: { type: 'number' } },
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: { p: { $ref: '#/$defs/P' } },
      $defs: { P: { type: 'string' } },
      definitions: { Q: { type: 'number' } },
    });
  });
});

describe('parseMcpArgs', () => {
  const single = mcpCommands('fs', [
    { name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  ])[0];
  const multi = mcpCommands('gh', [
    {
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'number' } },
      },
    },
  ])[0];
  const none = mcpCommands('calc', [
    { name: 'now', inputSchema: { type: 'object', properties: {} } },
  ])[0];

  it('parses a JSON object', () => {
    expect(parseMcpArgs(multi, '{"q":"reika","limit":2}')).toEqual({
      args: { q: 'reika', limit: 2 },
    });
  });

  it('treats a bare string as the only argument of a one-string-field tool', () => {
    expect(parseMcpArgs(single, 'src/index.ts')).toEqual({ args: { path: 'src/index.ts' } });
    // An untyped single field is the server saying it does not care, so the shortcut still applies.
    const untyped = mcpCommands('x', [
      { name: 'y', inputSchema: { type: 'object', properties: { q: {} } } },
    ])[0];
    expect(parseMcpArgs(untyped, 'hello')).toEqual({ args: { q: 'hello' } });
    // A declared number does not: `{limit: "5"}` is a type error the server would have to report.
    const numeric = mcpCommands('x', [
      { name: 'y', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    ])[0];
    const bad = parseMcpArgs(numeric, '5');
    expect('error' in bad && bad.error).toContain('{"limit": …');
    expect(parseMcpArgs(numeric, '{"limit":5}')).toEqual({ args: { limit: 5 } });
  });

  it('explains what a multi-field tool needs instead of guessing', () => {
    const bad = parseMcpArgs(multi, 'reika');
    expect('error' in bad && bad.error).toContain('{"q": …');
    const malformed = parseMcpArgs(multi, '{"q":');
    expect('error' in malformed && malformed.error).toContain('not valid JSON');
    const array = parseMcpArgs(multi, '[1,2]');
    expect('error' in array && array.error).toBe('Arguments must be a JSON object.');
  });

  it('sends nothing for a tool with no arguments, and an empty string for an ungiven one', () => {
    expect(parseMcpArgs(none, '')).toEqual({ args: {} });
    expect(parseMcpArgs(single, '')).toEqual({ args: { path: '' } });
    const bad = parseMcpArgs(multi, '');
    expect('error' in bad && bad.error).toContain('takes JSON arguments');
  });
});

describe('findMcpCommand', () => {
  const commands = mcpCommands('fs', [
    { name: 'read', inputSchema: { type: 'object', properties: {} } },
  ]);

  it('matches a command line case-insensitively and keeps the rest', () => {
    expect(findMcpCommand('/FS:READ {"path":"a"}', commands)).toEqual({
      command: commands[0],
      rest: '{"path":"a"}',
    });
    expect(findMcpCommand('/fs:read', commands)).toEqual({ command: commands[0], rest: '' });
  });

  it('ignores anything that is not one of its commands', () => {
    expect(findMcpCommand('fs:read x', commands)).toBeUndefined();
    expect(findMcpCommand('/help', commands)).toBeUndefined();
    expect(findMcpCommand('/fs:readx', commands)).toBeUndefined();
  });
});

describe('formatMcpResult', () => {
  it('joins text blocks and reports the size', () => {
    const r = formatMcpResult('fs:read', {
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });
    expect(r.summary).toBe('mcp fs:read — 18 chars');
    expect(r.payload).toBe('line one\n\nline two');
  });

  it('marks what it cannot carry: images, binary resources, links, unknown blocks', () => {
    const r = formatMcpResult('fs:read', {
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'embedded text' } },
        {
          type: 'resource',
          resource: { uri: 'file:///y', mimeType: 'application/pdf', blob: 'AA' },
        },
        { type: 'resource_link', uri: 'file:///z' },
        { type: 'video' },
      ],
    });
    expect(r.payload).toBe(
      [
        'see this',
        '[image image/png — 3B]',
        'embedded text',
        '[resource file:///y (application/pdf) — binary, not shown]',
        '[resource link file:///z]',
        '[video content — not shown]',
      ].join('\n\n'),
    );
  });

  it('falls back to structuredContent only when there is no text', () => {
    expect(formatMcpResult('s:t', { structuredContent: { ok: true } }).payload).toBe(
      '{\n  "ok": true\n}',
    );
    expect(
      formatMcpResult('s:t', {
        content: [{ type: 'text', text: 'x' }],
        structuredContent: { ok: true },
      }).payload,
    ).toBe('x');
  });

  it('names a failure with the first line of what the server said', () => {
    const r = formatMcpResult('s:t', {
      isError: true,
      content: [{ type: 'text', text: 'boom\nstack trace' }],
    });
    expect(r.summary).toBe('mcp s:t failed — boom');
    expect(r.payload).toBe('boom\nstack trace');
  });

  it('claims nothing when a call returns no content', () => {
    expect(formatMcpResult('s:t', {})).toEqual({ summary: 'mcp s:t — no content' });
    expect(formatMcpResult('s:t', { isError: true })).toEqual({ summary: 'mcp s:t failed' });
  });

  // The declared type is `McpContentBlock[]`, but the value is a server's own JSON. Reading a block
  // that is not an object threw, which took the text blocks beside it down and reported a call that
  // answered as a failure — and a `content` that is not a list at all was walked character by
  // character, one marker each (#265 review).
  it('reads past content that is not what the type promises', () => {
    const mixed = formatMcpResult('s:t', {
      content: [null, 42, { type: 'text', text: 'ok' }] as unknown as McpContentBlock[],
    });
    expect(mixed.payload).toBe(
      ['[malformed content — not shown]', '[malformed content — not shown]', 'ok'].join('\n\n'),
    );
    expect(mixed.summary).not.toContain('failed');

    const notAList = formatMcpResult('s:t', { content: 'oops' as unknown as McpContentBlock[] });
    expect(notAList).toEqual({
      summary: 'mcp s:t — 31 chars',
      payload: '[malformed content — not shown]',
    });

    // A marker is not something the server read out, so the typed half still comes through: the
    // fall-back is about whether there was any readable content at all.
    const both = formatMcpResult('s:t', {
      content: [null] as unknown as McpContentBlock[],
      structuredContent: { total: 3 },
    });
    expect(both.payload).toBe('[malformed content — not shown]\n\n{\n  "total": 3\n}');
  });
});

describe('mcpTool', () => {
  const def = {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };

  it('exposes the server description and the declared schema', () => {
    const tool = mcpTool('fs', def, never);
    expect(tool.name).toBe('mcp__fs__read');
    expect(tool.description).toBe('Read a file');
    expect(tool.parameters.required).toBeUndefined();
    expect(mcpTool('blank', { name: 'x' }, never).description).toBe(
      'MCP tool x from server "blank".',
    );
  });

  it('runs through the approval gate and honours a decline', async () => {
    const call = vi.fn(never);
    const tool = mcpTool('fs', def, call);
    const requestApproval = vi.fn(() => Promise.resolve(false));
    const result = await tool.run({ path: 'a.ts' }, ctx({ requestApproval }));
    expect(result.summary).toBe('Call declined by user fs:read');
    expect(call).not.toHaveBeenCalled();
    // Unattended says why nobody answered, so the model carries on instead of asking again.
    const unattended = await tool.run({ path: 'a.ts' }, ctx({ requestApproval, unattended: true }));
    expect(unattended.summary).toContain('nobody to approve it');
    expect(requestApproval).toHaveBeenCalledWith({
      tool: 'mcp__fs__read',
      subject: 'fs:read',
      preview: '{"path":"a.ts"}',
    });
  });

  it('calls the server once approved, and formats what comes back', async () => {
    const tool = mcpTool('fs', def, (server, name, args) => {
      expect([server, name, args]).toEqual(['fs', 'read', { path: 'a.ts' }]);
      return Promise.resolve({ content: [{ type: 'text', text: 'file body' }] });
    });
    const result = await tool.run(
      { path: 'a.ts' },
      ctx({ requestApproval: () => Promise.resolve(true) }),
    );
    expect(result).toEqual({ summary: 'mcp fs:read — 9 chars', payload: 'file body' });
  });

  it('runs without a gate under bypass, and turns a throw into a summary', async () => {
    const tool = mcpTool('fs', def, () => Promise.reject(new Error('pipe closed')));
    expect(await tool.run({}, ctx())).toEqual({ summary: 'mcp fs:read failed: pipe closed' });
  });
});

describe('invokeMcpTool', () => {
  it('is the same path the slash command takes', async () => {
    const call = () => Promise.resolve({ content: [{ type: 'text', text: 'hi' }] });
    expect(await invokeMcpTool(call, 'fs:read', 'fs', 'read', {})).toEqual({
      summary: 'mcp fs:read — 2 chars',
      payload: 'hi',
    });
  });
});

describe('callMcpTool', () => {
  // The headless exit status is decided here, not by re-reading a summary string: a tool-level
  // failure (isError) and a transport one (the call threw) are both failures.
  it('reports a tool-level failure as failed, with the payload intact', async () => {
    const call = () =>
      Promise.resolve({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    expect(await callMcpTool(call, 'fs:read', 'fs', 'read', {})).toEqual({
      result: { summary: 'mcp fs:read failed — boom', payload: 'boom' },
      failed: true,
    });
  });

  it('reports a transport failure as failed, with the reason in the summary', async () => {
    const call = () => Promise.reject(new Error('pipe closed'));
    expect(await callMcpTool(call, 'fs:read', 'fs', 'read', {})).toEqual({
      result: { summary: 'mcp fs:read failed: pipe closed' },
      failed: true,
    });
  });

  it('is the same formatting the model sees when nothing failed', async () => {
    const call = () => Promise.resolve({ content: [{ type: 'text', text: 'hi' }] });
    expect(await callMcpTool(call, 'fs:read', 'fs', 'read', {})).toEqual({
      result: { summary: 'mcp fs:read — 2 chars', payload: 'hi' },
      failed: false,
    });
  });
});

// An MCP result is server-authored and unbounded; the model's copy is held to the bash/fetch cap,
// with the rest saved where it can be paged.
describe('capMcpPayload', () => {
  it('passes a result under the cap through unchanged', async () => {
    const result = { summary: 'mcp s:t — 2 chars', payload: 'ok' };
    expect(await capMcpPayload(result)).toBe(result);
  });

  it('cuts an oversized payload and points at the saved rest', async () => {
    const big = 'a'.repeat(64 * 1024) + 'TAIL';
    const out = await capMcpPayload({ summary: 'mcp s:t', payload: big });
    expect(out.payload).not.toContain('TAIL');
    expect(out.payload).toMatch(/Showing 65536 of 65540 chars/);
    expect(out.payload).toMatch(/Do not re-run this call/);
  });
});
