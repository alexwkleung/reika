import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { debugLog } from '../debug.js';
import { VERSION } from '../version.js';
import { CONNECT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, type McpServerConfig } from './config.js';

// The stdio half of MCP (protocol revision 2025-06-18), which is what "an MCP server" means for
// almost everything shipped today: a child process speaking JSON-RPC 2.0 over stdin/stdout, one
// message per line. The HTTP/SSE transports are deliberately not here — a remote server is a
// different trust and auth question, and this module's job is the local case (#265).
//
// Framing: the spec requires messages to be newline-delimited with no embedded newlines, so a
// buffer split on '\n' is the whole parser. Anything that does not parse is dropped rather than
// fatal: a server that prints a banner to stdout is out of spec but common, and losing the session
// over it would be worse than ignoring the line.
export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'reika';
// How much of a server's stderr is kept for the error message. A server that fails at startup
// explains itself there and nowhere else; unbounded, a chatty server would eat the heap.
const STDERR_TAIL_CHARS = 2000;

// Every spawned server, killed when reika exits whatever route it leaves by. A stdio server's
// parent dying closes its pipes — which most servers treat as EOF and exit on — but one mid-call
// would linger as an orphan, and one hook covers every session (and every test) at once.
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
process.once('exit', () => {
  for (const child of liveChildren) child.kill();
});

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

// The spec's block union, kept loose on purpose: this is a server's JSON, so every field is
// re-checked at use (see formatMcpResult's blockLines) rather than trusted from the type.
export type McpContentBlock = {
  // 'text', 'image', 'audio', 'resource', 'resource_link', or anything a future revision adds.
  type?: unknown;
  [k: string]: unknown;
};

export type McpCallResult = {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpServerInfo = {
  name: string;
  version?: string;
  // The server's own "instructions" text — a short note about how to use its tools. Kept for
  // `/mcp`, not injected into the prompt: it is server-authored prose of unknown length.
  instructions?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClient {
  readonly config: McpServerConfig;
  server: McpServerInfo = { name: '' };
  tools: McpToolDef[] = [];
  // Set by `notifications/tools/list_changed`. The tool list is part of the request's cached
  // prefix, so it cannot change mid-session; `/mcp` surfaces this instead.
  toolsChanged = false;

  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  private stderrTail = '';
  private dead: Error | undefined;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get name(): string {
    return this.config.name;
  }

  get lastStderr(): string {
    return this.stderrTail.trim();
  }

  // Spawn + handshake + tool discovery. Resolves only on a server that answered `initialize`
  // AND `tools/list`: a server that started but says nothing is a failure the user has to see.
  async connect(): Promise<void> {
    await this.start();
    try {
      const init = await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          // `roots` is declared empty rather than absent: the server may ask, and answering "no
          // roots" is what keeps it from inventing a workspace of its own.
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: CLIENT_NAME, version: VERSION },
        },
        CONNECT_TIMEOUT_MS,
      );
      this.server = readServerInfo(init);
      this.notify('notifications/initialized', {});
      this.tools = await this.listTools();
    } catch (e) {
      this.close();
      throw new Error(this.explain(e));
    }
  }

  // `tools/list`, following the spec's cursor pagination. Capped so a server that always returns a
  // cursor cannot spin the startup forever.
  private async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = (await this.request(
        'tools/list',
        cursor ? { cursor } : {},
        CONNECT_TIMEOUT_MS,
      )) as { tools?: unknown; nextCursor?: unknown };
      const list = Array.isArray(res?.tools) ? res.tools : [];
      for (const t of list) {
        if (typeof t !== 'object' || t === null) continue;
        const def = t as Record<string, unknown>;
        if (typeof def.name !== 'string' || !def.name) continue;
        out.push({
          name: def.name,
          ...(typeof def.description === 'string' ? { description: def.description } : {}),
          ...(isRecord(def.inputSchema) ? { inputSchema: def.inputSchema } : {}),
        });
      }
      if (typeof res?.nextCursor !== 'string' || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = (await this.request(
      'tools/call',
      { name, arguments: args },
      timeoutMs,
      opts.signal,
    )) as McpCallResult | undefined;
    return isRecord(res) ? (res as McpCallResult) : {};
  }

  close(): void {
    this.rejectInFlight(new Error('closed'));
    const child = this.child;
    this.child = undefined;
    // A child that already exited needs nothing, and ending its stdin would be a write to a
    // destroyed stream — the one thing this must not do on the way out.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill();
    }
  }

  // --- transport ---------------------------------------------------------------------------

  private start(): Promise<void> {
    const { command, args, env, cwd } = this.config;
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          ...(cwd ? { cwd } : {}),
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new Error(`could not start ${command}: ${errText(e)}`));
        return;
      }
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
      child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
      // A write that races the child's death raises EPIPE on stdin — an unhandled 'error' on a
      // stream is a process-level crash, and the exit handler below is what actually fails the call.
      child.stdin.on('error', (e: Error) =>
        debugLog(`[reika:debug] mcp ${this.name}: stdin ${e.message}\n`),
      );
      // A child that dies takes every in-flight request with it. The error surfaces here rather
      // than as a hang: a server that exits mid-call is exactly the bug the user must be told.
      child.on('error', (e: Error) => {
        this.dead = new Error(`could not start ${command}: ${e.message}`);
        this.rejectInFlight(this.dead);
        reject(this.dead);
      });
      child.on('exit', (code, signal) => {
        liveChildren.delete(child);
        this.dead = new Error(
          `server exited (${signal ? `signal ${signal}` : `code ${code}`})${this.stderrSuffix()}`,
        );
        this.rejectInFlight(this.dead);
      });
      liveChildren.add(child);
      resolve();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        debugLog(
          `[reika:debug] mcp ${this.name}: unparseable stdout line (${line.length} chars)\n`,
        );
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const err = msg.error;
      if (err !== undefined) entry.reject(new Error(rpcErrorMessage(err)));
      else entry.resolve(msg.result);
      return;
    }
    if (id !== undefined && typeof msg.method === 'string') {
      // A request FROM the server. Answering is not optional — an unanswered request is how a
      // server decides its peer is gone — and there is nothing here to sample or to root, so the
      // honest answer is an error for anything beyond the spec's `ping`.
      const method = msg.method;
      if (method === 'ping') this.send({ jsonrpc: '2.0', id, result: {} });
      else if (method === 'roots/list') this.send({ jsonrpc: '2.0', id, result: { roots: [] } });
      else
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `reika does not implement ${method}` },
        });
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') this.toolsChanged = true;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // One request's bound, not the connection's: a timed-out call leaves the server running and
      // later calls work, which is the recovery a slow tool needs.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      // An unref'd timer cannot hold the process open on its own; the child's pipes already do.
      timer.unref?.();
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        // The request is abandoned, not cancelled: the spec's cancellation notification would
        // need a reason and an answer we do not wait on, and the result is dropped either way.
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: v => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: e => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private rejectInFlight(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private stderrSuffix(): string {
    const tail = this.lastStderr;
    return tail ? ` — ${tail.split('\n').slice(-3).join(' ')}` : '';
  }

  private explain(e: unknown): string {
    const msg = errText(e);
    const tail = this.stderrSuffix();
    return tail && !msg.includes(tail.trim()) ? `${msg}${tail}` : msg;
  }
}

// `serverInfo` is where a server introduces itself; `/mcp` prints it next to the server's config
// name so a wrapper entry (npx) still says what actually answered.
function readServerInfo(init: unknown): McpServerInfo {
  const result = isRecord(init) && isRecord(init.serverInfo) ? init.serverInfo : {};
  return {
    name: typeof result.name === 'string' ? result.name : '',
    ...(typeof result.version === 'string' ? { version: result.version } : {}),
    ...(isRecord(init) && typeof init.instructions === 'string'
      ? { instructions: init.instructions }
      : {}),
  };
}

function rpcErrorMessage(err: unknown): string {
  if (isRecord(err) && typeof err.message === 'string') {
    return typeof err.code === 'number' ? `${err.message} (${err.code})` : err.message;
  }
  return JSON.stringify(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
