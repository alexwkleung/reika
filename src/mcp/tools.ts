import { createHash } from 'node:crypto';
import type { Tool, ToolContext, ToolParameters, ToolResult } from '../types.js';
import { declineSummary } from '../approval.js';
import { kFormat } from '../ui/format.js';
import { buildCappedFooter, buildSpillFooter, spillResult } from '../tools/_spill.js';
import type { McpCallResult, McpContentBlock, McpToolDef } from './client.js';
import { MCP_TOOL_PREFIX } from './config.js';

// The bridge from a server's tools to Reika's `Tool`. Namespacing (`mcp__server__tool`) is what
// keeps two servers' identically-named tools apart in one request — the wire has one flat tool
// namespace, and a later server silently shadowing an earlier one is the failure this prevents.
// Providers validate tool names (`^[a-zA-Z0-9_-]{1,64}$` for OpenAI-compatible endpoints), and a
// server may name a tool with dots or spaces, so both parts are slugged and the whole capped.
const MAX_TOOL_NAME = 64;
// Model-facing descriptions are paid for every round. An MCP description is server-authored and
// can be a page of prose; the first lines say what the tool does, and the rest is a schema the
// model already receives as `parameters`.
const MAX_DESCRIPTION = 400;
// A tool result the model receives inline, the same cap `bash` and `fetch_url` hold theirs to. An
// MCP server can return anything (a whole file, a database dump), and the result lands in history,
// where it is carried until it ages out. The rest is saved to a spill file the model can page.
const MAX_PAYLOAD_CHARS = 64 * 1024;

export type McpCallFn = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<McpCallResult>;

// A tool the user can invoke directly as a slash command (#265). `name` is the lowercased
// `<server>:<tool>` the command line uses; without the colon it could collide with a built-in.
export type McpCommand = {
  name: string;
  server: string;
  tool: string;
  description: string;
  parameters: ToolParameters;
};

export function mcpToolName(server: string, tool: string): string {
  const full = `${MCP_TOOL_PREFIX}${slug(server)}__${slug(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  // Truncation has to stay unique: two long tool names from one server share a prefix, and a
  // collision would make one of them uncallable. A hash of the full name carries the difference.
  //
  // Slugging is lossy in the same direction and is NOT covered by this: a server offering both
  // `read_file` and `read file` (or two servers named `a b` and `a-b`) produces one wire name, and
  // dispatch resolves the first match, so the second is unreachable. Known and accepted — a name
  // that already collides has to be legal for the endpoint anyway — but the hash is not what makes
  // these names unique.
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

export function mcpCommandName(server: string, tool: string): string {
  return `${server}:${tool}`.toLowerCase().replace(/\s+/g, '-');
}

export function mcpCommands(server: string, tools: McpToolDef[]): McpCommand[] {
  return tools.map(def => ({
    name: mcpCommandName(server, def.name),
    server,
    tool: def.name,
    description: firstLine(truncate(def.description ?? '', MAX_DESCRIPTION)),
    parameters: schemaToParameters(def.inputSchema),
  }));
}

export function mcpTool(server: string, def: McpToolDef, call: McpCallFn): Tool {
  const name = mcpToolName(server, def.name);
  const label = `${server}:${def.name}`;
  return {
    name,
    description: toolDescription(server, def),
    parameters: schemaToParameters(def.inputSchema),
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      // Every MCP call goes through the gate (AGENTS.md, "Adding a new tool"): a server's tool is
      // opaque — the harness cannot tell a calculator from something that writes files — so the
      // policy decides rather than the tool. No `warnings`, so under the default `safe` an ordinary
      // call runs unprompted; under `off` it prompts, and under `bypass` there is nobody to ask.
      if (ctx.requestApproval) {
        const ok = await ctx.requestApproval({
          tool: name,
          subject: label,
          preview: previewArgs(args),
        });
        if (!ok) return { summary: declineSummary('Call', ` ${label}`, ctx) };
      }
      const result = await invokeMcpTool(call, label, server, def.name, args, {
        signal: ctx.signal,
      });
      return capMcpPayload(result);
    },
  };
}

// Only the model's path is capped: a slash command's output is the user reading the tool, and it
// never enters history.
export async function capMcpPayload(result: ToolResult): Promise<ToolResult> {
  const payload = result.payload;
  if (!payload || payload.length <= MAX_PAYLOAD_CHARS) return result;
  const total = String(payload.length);
  const ref = await spillResult('mcp', payload);
  const footer = ref
    ? buildSpillFooter({ shown: MAX_PAYLOAD_CHARS, total, unit: 'chars', ref, subject: 'call' })
    : buildCappedFooter({
        shown: MAX_PAYLOAD_CHARS,
        total,
        unit: 'chars',
        advice: 'call the tool with narrower arguments to see the rest',
      });
  return { ...result, payload: payload.slice(0, MAX_PAYLOAD_CHARS) + footer };
}

// The one call path, shared by the model's tool and the user's slash command, so a formatted
// result reads the same either way. Failures come back as a summary rather than a throw: a broken
// server must cost one round, the way a failed bash command does.
export async function invokeMcpTool(
  call: McpCallFn,
  label: string,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolResult> {
  return (await callMcpTool(call, label, server, tool, args, opts)).result;
}

// The same call and the same formatting, plus whether it failed — the one thing `reika -p
// "/x:y"` cannot read out of a summary to decide its exit status. A JSON-RPC error (the call threw)
// and a tool-level one (`isError`) both count.
export async function callMcpTool(
  call: McpCallFn,
  label: string,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ result: ToolResult; failed: boolean }> {
  try {
    const result = await call(server, tool, args, opts);
    return { result: formatMcpResult(label, result), failed: result.isError === true };
  } catch (e) {
    return {
      result: { summary: `mcp ${label} failed: ${(e as Error).message}` },
      failed: true,
    };
  }
}

// MCP content is a list of blocks; Reika's tool result is one summary plus one text payload. Text
// passes through, and everything else becomes a marker line — an image has no reader here (the
// vision pipeline is for images the *user* pasted), and dropping the block silently would leave
// the model unaware that the call returned something it cannot see.
//
// The type says `content: McpContentBlock[]`, but the value is a server's own JSON, so the list and
// each element are re-checked here the way `listTools` re-checks a tool. Reading a `null` or a bare
// string as a block is a TypeError that takes the text blocks beside it down with it, reporting a
// call that answered as a failure; a `content` that is not a list at all would be walked as its
// characters, one bogus marker each.
const MALFORMED_CONTENT = '[malformed content — not shown]';

export function formatMcpResult(label: string, result: McpCallResult): ToolResult {
  const parts: string[] = [];
  // Counted separately from `parts`: a malformed marker is not content a server read out, and the
  // fall-back below is about whether the server gave us anything to read at all.
  let read = 0;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block)) {
        parts.push(MALFORMED_CONTENT);
        continue;
      }
      const lines = blockLines(block);
      read += lines.length;
      parts.push(...lines);
    }
  } else if (result.content != null) {
    parts.push(MALFORMED_CONTENT);
  }
  const structured = structuredLine(result.structuredContent, read === 0);
  if (structured) parts.push(structured);
  const payload = parts.length > 0 ? parts.join('\n\n') : undefined;
  const first = parts.find(p => p.trim() !== '')?.split('\n')[0] ?? '';
  if (result.isError) {
    return {
      summary: `mcp ${label} failed${first ? ` — ${truncate(first, 200)}` : ''}`,
      ...(payload ? { payload } : {}),
    };
  }
  const size = payload ? ` — ${kFormat(payload.length)} chars` : ' — no content';
  return { summary: `mcp ${label}${size}`, ...(payload ? { payload } : {}) };
}

function blockLines(block: McpContentBlock): string[] {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  switch (type) {
    case 'text':
      return typeof block.text === 'string' && block.text !== '' ? [block.text] : [];
    case 'image':
      return [`[image ${str(block.mimeType) || 'unknown'} — ${byteSize(block.data)}]`];
    case 'audio':
      return [`[audio ${str(block.mimeType) || 'unknown'} — ${byteSize(block.data)}]`];
    case 'resource': {
      // An embedded resource carries its content inline: text when the server could read it,
      // a base64 blob otherwise (which this pipeline cannot use).
      const resource = isRecord(block.resource) ? block.resource : {};
      const uri = str(resource.uri) || 'unknown';
      if (typeof resource.text === 'string') return [resource.text];
      const mime = str(resource.mimeType);
      return [`[resource ${uri}${mime ? ` (${mime})` : ''} — binary, not shown]`];
    }
    case 'resource_link':
      return [`[resource link ${str(block.uri) || 'unknown'}]`];
    default:
      return [`[${type} content — not shown]`];
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Servers that return typed results send `structuredContent` alongside (or instead of) content.
// Only when there is no text to read: printing both would double the payload for the common server
// that sends the same data twice in two shapes.
function structuredLine(structured: unknown, noText: boolean): string | undefined {
  if (structured === undefined || !noText) return undefined;
  try {
    return JSON.stringify(structured, null, 2);
  } catch {
    return undefined;
  }
}

// What the model sees as the tool's description. The server's own text is the useful part; the
// server's name goes in because a request can hold tools from several of them.
function toolDescription(server: string, def: McpToolDef): string {
  const own = (def.description ?? '').trim();
  if (!own) return `MCP tool ${def.name} from server "${server}".`;
  return truncate(own, MAX_DESCRIPTION);
}

// The capabilities a tool declares, narrowed to what every provider accepts. The MCP schema is
// arbitrary JSON Schema — `$schema`, `$defs`, unions — and an endpoint that rejects one keyword
// fails the whole request, so only the keys a tool call actually needs pass through. The two
// definition maps are part of that set: a property can `$ref` into them, and narrowing the top
// level away while keeping the reference leaves a schema nothing can resolve.
export function schemaToParameters(schema: Record<string, unknown> | undefined): ToolParameters {
  const props = isRecord(schema?.properties) ? schema.properties : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : undefined;
  return {
    type: 'object',
    properties: props,
    ...(isRecord(schema?.$defs) ? { $defs: schema.$defs } : {}),
    ...(isRecord(schema?.definitions) ? { definitions: schema.definitions } : {}),
    ...(required && required.length > 0 ? { required } : {}),
  };
}

export type McpArgParse = { args: Record<string, unknown> } | { error: string };

// A slash command's arguments, for a human typing at a prompt: a JSON object when the tool takes
// more than one field, and the bare string when the tool takes exactly one string (which is what
// most single-purpose servers declare — `/github:get_file src/index.ts` should not require
// `{"path":…}`). A single field of another type does not get the shortcut: `{limit: "5"}` for a
// declared number is a type error the server has to report, where requiring JSON says why first.
export function parseMcpArgs(command: McpCommand, text: string): McpArgParse {
  const trimmed = text.trim();
  // Either JSON shape is attempted as JSON: an array is a user mistake worth naming ("must be an
  // object"), not something to guess a field for.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return { error: 'Arguments must be a JSON object.' };
      return { args: parsed };
    } catch (e) {
      return { error: `Arguments are not valid JSON: ${(e as Error).message}` };
    }
  }
  const fields = Object.keys(command.parameters.properties);
  const only = fields.length === 1 ? fields[0] : undefined;
  const single = only && takesString(command.parameters.properties[only]) ? only : undefined;
  if (trimmed === '') {
    if (single) return { args: { [single]: '' } };
    if (fields.length === 0) return { args: {} };
    return { error: jsonHint(command, fields) };
  }
  if (single) return { args: { [single]: trimmed } };
  return { error: jsonHint(command, fields) };
}

// No declared type is treated as a string: an untyped schema is the server saying it does not care,
// and refusing the shortcut there would cost a JSON wrapper for no gain.
function takesString(spec: unknown): boolean {
  if (!isRecord(spec)) return true;
  return spec.type === undefined || spec.type === 'string';
}

function jsonHint(command: McpCommand, fields: string[]): string {
  return `${command.name} takes JSON arguments: {${fields.map(f => `"${f}": …`).join(', ')}}`;
}

// The command a prompt line names, if it names one: `/filesystem:read_file {"path":"a.ts"}`.
// Case-insensitive because the UI lowercases what it dispatches.
export function findMcpCommand(
  line: string,
  commands: McpCommand[],
): { command: McpCommand; rest: string } | undefined {
  if (!line.startsWith('/')) return undefined;
  const rest = line.slice(1);
  const space = rest.search(/\s/);
  const name = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
  const command = commands.find(c => c.name === name);
  if (!command) return undefined;
  return { command, rest: space === -1 ? '' : rest.slice(space + 1) };
}

function previewArgs(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return '(no arguments)';
  try {
    return truncate(JSON.stringify(args), 400);
  } catch {
    return '(unprintable arguments)';
  }
}

function slug(name: string): string {
  const out = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return out || 'server';
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Base64 blocks arrive at 4/3 their byte size, so the marker reports what the bytes actually are.
function byteSize(data: unknown): string {
  if (typeof data !== 'string') return 'unknown size';
  return `${kFormat(Math.floor((data.length * 3) / 4))}B`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
