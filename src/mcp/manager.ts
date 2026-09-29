import type { Tool } from '../types.js';
import { McpClient, type McpCallResult, type McpServerInfo } from './client.js';
import type { McpServerConfig } from './config.js';
import { mcpCommands, mcpTool, type McpCommand } from './tools.js';

// What one configured server came to. Kept whether it worked or not: `/mcp` has to be able to say
// why a server the user configured contributed nothing.
export type McpServerStatus = {
  name: string;
  tools: number;
  error?: string;
  info?: McpServerInfo;
  commands: McpCommand[];
  // The server announced a changed tool list. The list is part of the request prefix, so it cannot
  // change mid-session — this is surfaced, not acted on.
  changed: boolean;
};

export type McpRuntime = {
  // Model-facing tools, namespaced `mcp__server__tool`.
  tools: Tool[];
  // The same tools as slash commands, `<server>:<tool>`.
  commands: McpCommand[];
  servers: McpServerStatus[];
  // Startup lines for the scrollback: what connected, what failed. Empty when nothing is
  // configured, so a reika with no MCP says nothing about it.
  notices: string[];
  list(): string;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallResult>;
  close(): void;
};

// Connect every configured server, in parallel: they are independent processes and the session's
// startup waits on all of them. A server that fails is reported and skipped — an MCP integration
// that cannot start must leave reika working, since it is an add-on to a session that is otherwise
// complete (#265).
export async function connectMcpServers(servers: McpServerConfig[]): Promise<McpRuntime> {
  if (servers.length === 0) {
    return {
      tools: [],
      commands: [],
      servers: [],
      notices: [],
      list: () => unconfiguredNotice(),
      call: (server: string) => Promise.reject(new Error(`no MCP server "${server}"`)),
      close: () => {},
    };
  }
  const clients = new Map<string, McpClient>();
  const statuses: McpServerStatus[] = [];
  const connected = await Promise.all(
    servers.map(async (config): Promise<McpClient | McpServerStatus> => {
      const client = new McpClient(config);
      try {
        await client.connect();
        return client;
      } catch (e) {
        client.close();
        return {
          name: config.name,
          tools: 0,
          error: (e as Error).message,
          commands: [],
          changed: false,
        };
      }
    }),
  );

  const tools: Tool[] = [];
  const commands: McpCommand[] = [];
  for (const entry of connected) {
    if (!(entry instanceof McpClient)) {
      statuses.push(entry);
      continue;
    }
    clients.set(entry.name, entry);
    const call = (
      server: string,
      tool: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<McpCallResult> => {
      const target = clients.get(server);
      if (!target) return Promise.reject(new Error(`no MCP server "${server}"`));
      return target.callTool(tool, args, opts);
    };
    const serverCommands = mcpCommands(entry.name, entry.tools);
    for (const def of entry.tools) tools.push(mcpTool(entry.name, def, call));
    commands.push(...serverCommands);
    statuses.push({
      name: entry.name,
      tools: entry.tools.length,
      info: entry.server,
      commands: serverCommands,
      // Read through to the client, not copied: a server announces a changed tool list when its
      // tools actually change, which is later than this snapshot — a copy would only ever see one
      // that happened to land during the handshake, and `/mcp` would never report the real case.
      get changed() {
        return entry.toolsChanged;
      },
    });
  }

  return {
    tools,
    commands,
    servers: statuses,
    notices: connectNotices(statuses),
    list: () => formatMcpList(statuses),
    call(server, tool, args, opts) {
      const target = clients.get(server);
      if (!target) return Promise.reject(new Error(`no MCP server "${server}"`));
      return target.callTool(tool, args, opts);
    },
    close() {
      for (const client of clients.values()) client.close();
    },
  };
}

// One line per session, not one per server: on a healthy launch the interesting fact is the total,
// and the names are one `/mcp` away. Failures get their own line each, because a server that did
// not start is the thing the user has to act on.
function connectNotices(statuses: McpServerStatus[]): string[] {
  const live = statuses.filter(s => !s.error);
  const notices: string[] = [];
  if (live.length > 0) {
    const total = live.reduce((n, s) => n + s.tools, 0);
    notices.push(
      `MCP: ${live.map(s => `${s.name} (${s.tools} tool${s.tools === 1 ? '' : 's'})`).join(', ')} — ${total} tool${total === 1 ? '' : 's'} added in agent mode. /mcp lists them.`,
    );
  }
  for (const s of statuses) {
    if (s.error) notices.push(`MCP server "${s.name}" unavailable: ${s.error} — it is skipped.`);
  }
  return notices;
}

export function unconfiguredNotice(): string {
  return [
    'No MCP servers configured.',
    'Set REIKA_MCP_SERVERS to the JSON (or to a path of a JSON file) of your servers:',
    '  REIKA_MCP_SERVERS={"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}',
    'Each server\u2019s tools also become slash commands, as /<server>:<tool>.',
  ].join('\n');
}

// `/mcp`: what is connected and what each server offers. The commands are printed as they are
// typed — this is the reference a user reads to invoke one.
export function formatMcpList(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) return unconfiguredNotice();
  const lines: string[] = [];
  const live = statuses.filter(s => !s.error);
  const total = live.reduce((n, s) => n + s.tools, 0);
  lines.push(
    `MCP: ${live.length} server${live.length === 1 ? '' : 's'}, ${total} tool${total === 1 ? '' : 's'} (agent mode; also the commands below)`,
  );
  for (const s of statuses) {
    const who = s.info?.name
      ? `${s.info.name}${s.info.version ? ` ${s.info.version}` : ''}`
      : 'server';
    if (s.error) {
      lines.push(`  ${s.name} — unavailable: ${s.error}`);
      continue;
    }
    lines.push(`  ${s.name} — ${s.tools} tool${s.tools === 1 ? '' : 's'} (${who})`);
    for (const c of s.commands) lines.push(`    /${c.name.padEnd(28)} ${c.description}`);
    if (s.changed)
      lines.push(
        `    (this server announced a changed tool list — restart reika to pick it up; the tool list is part of the cached request prefix)`,
      );
  }
  return lines.join('\n');
}
