import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// One stdio MCP server, in the shape every MCP client uses (`mcpServers` in a Claude Desktop or
// Cursor config): a command to spawn and the argv/env it gets. `REIKA_MCP_SERVERS` holds this JSON
// inline or names a file containing it — see parseMcpServers.
export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  // How long one request may go unanswered before the call fails, ms. Undefined = DEFAULT_TIMEOUT_MS.
  timeoutMs?: number;
  // The same bound for the handshake (initialize + tools/list), which happens before first paint.
  // Undefined = CONNECT_TIMEOUT_MS. Separate from `timeoutMs` because the two failure modes cost
  // different things: a generous call timeout must not turn a server that hangs at startup into a
  // minutes-long stall before the first frame, and a server behind a cold `npx` install can need
  // more than the default connect bound while its calls are quick.
  connectTimeoutMs?: number;
};

// The namespace Reika puts on a server's tools when it hands them to the model: `mcp__<server>__
// <tool>`. It lives here, in the module with no imports of its own, because both ends read it — the
// bridge that builds the name (tools.ts) and the UI that spells it back as `/<server>:<tool>`
// (ui/format.ts) — and tools.ts already imports ui/format.ts for `kFormat`, so a constant shared
// from there would close the loop.
export const MCP_TOOL_PREFIX = 'mcp__';

// A request that never answers is the common shape of a broken server (it started, then hung), and
// a model turn must not hang with it. Generous because a slow server is still a working one: a
// web-search MCP server can take a while, and this bound is only here to end the turn eventually.
export const DEFAULT_TIMEOUT_MS = 60_000;
// Startup is a different question from a call: initialize + tools/list happen before the first
// paint, so a server that hasn't answered in this long costs a session's startup for nothing.
export const CONNECT_TIMEOUT_MS = 15_000;

export type McpConfigResult = { servers: McpServerConfig[]; errors: string[] };

// `REIKA_MCP_SERVERS` is either the JSON itself or a path to a file holding it. Both spellings are
// on purpose: an env var is the config source (#265), and a file is where a list of servers
// actually lives — inline JSON in `.env` is unreadable past two entries and unusable for secrets.
//
// Accepted document shapes, all of them things people already have on disk:
//   { "mcpServers": { "name": { "command": … } } }   the standard wrapper
//   { "name": { "command": … } }                     the same map without the wrapper
//   [ { "name": "name", "command": … } ]             a list
// Anything malformed is reported rather than thrown: a typo in one server must not cost the
// session (fail-open, the same rule the rest of the config follows).
export function parseMcpServers(raw: string | undefined): McpConfigResult {
  const text = (raw ?? '').trim();
  if (!text) return { servers: [], errors: [] };
  let source = text;
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const path = resolveUserFile(text);
    try {
      source = readFileSync(path, 'utf8');
    } catch (e) {
      return { servers: [], errors: [`REIKA_MCP_SERVERS: cannot read ${path}: ${errText(e)}`] };
    }
  }
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch (e) {
    return { servers: [], errors: [`REIKA_MCP_SERVERS: invalid JSON: ${errText(e)}`] };
  }
  return readServerDoc(doc);
}

// The JSON's shape is decided by inspection, not by a flag: an object with an `mcpServers` key is
// the standard wrapper, any other object is the map itself, an array is a list. A map keeps its
// keys as names — that is where the name lives in every config file already written for another
// client, so a copied block works unchanged.
function readServerDoc(doc: unknown): McpConfigResult {
  const errors: string[] = [];
  const servers: McpServerConfig[] = [];
  const entries: [string, unknown][] = Array.isArray(doc)
    ? doc.map((v, i) => [entryName(v, i), v] as [string, unknown])
    : isRecord(doc)
      ? Object.entries(isRecord(doc.mcpServers) ? doc.mcpServers : doc)
      : [];
  if (entries.length === 0 && !Array.isArray(doc) && !isRecord(doc)) {
    return { servers: [], errors: ['REIKA_MCP_SERVERS: expected an object or a list of servers'] };
  }
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    const one = readServer(key, value);
    if (one === undefined) continue; // `"disabled": true` — kept in the file, not started
    if (typeof one === 'string') {
      errors.push(`MCP server "${key}": ${one}`);
      continue;
    }
    const name = one.name || key;
    if (!name) {
      errors.push('MCP server: entry has no name');
      continue;
    }
    if (seen.has(name)) {
      errors.push(`MCP server "${name}": duplicate name`);
      continue;
    }
    seen.add(name);
    servers.push({ ...one, name });
  }
  return { servers, errors };
}

function readServer(key: string, value: unknown): McpServerConfig | string | undefined {
  if (!isRecord(value)) return `expected an object, got ${typeof value}`;
  if (value.disabled === true) return undefined;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (!command) return 'needs a "command" string';
  const args = readStringList(value.args);
  if (typeof args === 'string') return args;
  const env = readEnv(value.env);
  if (typeof env === 'string') return env;
  const cwd = typeof value.cwd === 'string' && value.cwd.trim() ? value.cwd : undefined;
  const timeoutMs = readTimeout(value.timeoutMs ?? value.timeout);
  if (typeof timeoutMs === 'string') return timeoutMs;
  const connectTimeoutMs = readTimeout(value.connectTimeoutMs);
  if (typeof connectTimeoutMs === 'string') return connectTimeoutMs;
  // `name` inside the entry overrides the map key, for the array shape where there is no key.
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  return {
    name: name || key,
    command,
    args,
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
  };
}

function readStringList(raw: unknown): string[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return '"args" must be a list of strings';
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== 'string') return '"args" must be a list of strings';
    out.push(a);
  }
  return out;
}

function readEnv(raw: unknown): Record<string, string> | undefined | string {
  if (raw == null) return undefined;
  if (!isRecord(raw)) return '"env" must be an object of string values';
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') env[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v);
    else return `"env" value for ${k} must be a string`;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function readTimeout(raw: unknown): number | undefined | string {
  if (raw == null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return '"timeoutMs" must be a positive number of ms';
  return n;
}

function entryName(value: unknown, index: number): string {
  const name = isRecord(value) && typeof value.name === 'string' ? value.name.trim() : '';
  return name || `server${index + 1}`;
}

// A path, not JSON: `~/...` is what people type, and a relative one is against the cwd the session
// was launched in — the same resolution `REIKA_SKILLS_DIR` gets.
function resolveUserFile(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(process.cwd(), path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
