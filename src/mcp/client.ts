import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { debugLog } from '../debug.js';
import { VERSION } from '../version.js';
import { CONNECT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, type McpServerConfig } from './config.js';

// The stdio half of MCP, which is what "an MCP server" means for almost everything shipped today:
// a child process speaking JSON-RPC 2.0 over stdin/stdout, one message per line. The HTTP
// transports are deliberately not here — a remote server is a different trust and auth question,
// and this module's job is the local case (#265).
//
// Dual-era, per the spec's stdio backward-compatibility rule. 2026-07-28 ("modern") dropped the
// `initialize` handshake for a version and capabilities in every request's `_meta`; everything up
// to 2025-11-25 ("legacy") still opens with it, and a legacy-only client cannot reach a
// modern-only server at all. So `connect` probes with `server/discover` and falls back to
// `initialize` when the answer is not a modern one.
//
// Framing: the spec requires messages to be newline-delimited with no embedded newlines, so a
// buffer split on '\n' is the whole parser. Anything that does not parse is dropped rather than
// fatal: a server that prints a banner to stdout is out of spec but common, and losing the session
// over it would be worse than ignoring the line.
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
// What a legacy server may answer `initialize` with. Every revision here differs from the next in
// things this client never uses (auth, elicitation, tasks), so tools/list and tools/call read the
// same across all four.
const LEGACY_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
// How long the probe gets before `initialize` is sent beside it. Both SDKs' legacy servers answer
// an unknown method at once (-32601 / -32602), so this is only paid by a server that ignores one —
// or a modern one still starting, which the late probe answer then rescues (see handshake).
const PROBE_WAIT_MS = 2000;
// The spec reserves this JSON-RPC range for its own errors, so any of them on the probe means the
// server is modern and `initialize` must not be tried.
const MODERN_ERROR_MIN = -32099;
const MODERN_ERROR_MAX = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
// A modern tool may answer "call me again with this state" (input_required with requestState only).
// Bounded so a server that always does cannot keep a turn waiting forever.
const MAX_STATE_RETRIES = 3;
const CLIENT_NAME = 'reika';
// What a server inherits from reika's own environment: the set the official SDKs pass, plus temp
// and locale. Everything else stays behind — reika's environment holds the model API keys, every
// profile's keys and often a GH_TOKEN, and a server is third-party code from `npx`. A server that
// needs a variable gets it through its config entry's `env`.
const INHERITED_ENV =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'PROGRAMFILES',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
// How much of a server's stderr is kept for the error message. A server that fails at startup
// explains itself there and nowhere else; unbounded, a chatty server would eat the heap.
const STDERR_TAIL_CHARS = 2000;
// A stdout line longer than this is dropped rather than buffered: a message is newline-framed, so a
// server writing a blob with no newline (out of spec, but a buggy one can) grows the buffer until
// the heap goes. Far above any real single message; a tool result this size is useless anyway.
const MAX_STDOUT_LINE_CHARS = 8 * 1024 * 1024;
// The stdio binding's shutdown: close stdin, let the server exit on EOF, and only then signal. EOF
// is the one portable graceful signal, and a server that flushes state on it loses that to an
// immediate SIGTERM. The process-exit hook below stays an immediate kill: there is no time to wait.
const CLOSE_GRACE_MS = 2000;
const TERM_GRACE_MS = 1000;

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
  // The protocol revision this connection speaks, for `/mcp`: which era a server turned out to be
  // is the first question when one misbehaves.
  protocol?: string;
};

// A JSON-RPC error from the server, with its code kept: the probe decides the server's era on it.
class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(err: unknown) {
    super(rpcErrorMessage(err));
    this.code = isRecord(err) && typeof err.code === 'number' ? err.code : undefined;
    this.data = isRecord(err) ? err.data : undefined;
  }
}

type RequestOptions = {
  signal?: AbortSignal;
  // Whether abandoning this request tells the server so. Off for the handshake: legacy forbids
  // cancelling `initialize`, and the probe is one a legacy server never recognized.
  cancel?: boolean;
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

  private era: 'modern' | 'legacy' | undefined;
  private readonly probeWaitMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  // The rest of an oversized line is still arriving; drop it up to its newline.
  private discardingLine = false;
  private stderrTail = '';
  private exitError: Error | undefined;

  constructor(config: McpServerConfig, opts: { probeWaitMs?: number } = {}) {
    this.config = config;
    this.probeWaitMs = opts.probeWaitMs ?? PROBE_WAIT_MS;
  }

  get name(): string {
    return this.config.name;
  }

  // For the buffer-cap test: how much of an unterminated stdout line is held right now.
  get bufferedStdoutChars(): number {
    return this.stdoutBuffer.length;
  }

  get lastStderr(): string {
    return this.stderrTail.trim();
  }

  // Whether the child is gone. Read through by `/mcp` rather than copied into a startup status: a
  // server that dies mid-session is the same class of staleness as a changed tool list, and the
  // status snapshot is only true at the moment it was built.
  get dead(): boolean {
    return this.exitError !== undefined;
  }

  // The handshake's own bound: a server that is slow to start costs a session's first paint, which
  // a per-call timeout has no reason to govern (see McpServerConfig.connectTimeoutMs).
  private get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  // Spawn + handshake + tool discovery. Resolves only on a server that answered the handshake AND
  // `tools/list`: a server that started but says nothing is a failure the user has to see.
  async connect(): Promise<void> {
    await this.start();
    try {
      await this.handshake();
      this.tools = await this.listTools();
    } catch (e) {
      void this.close();
      throw new Error(this.explain(e));
    }
  }

  // The spec's stdio probe: `server/discover` first; a result or a spec-range error is a modern
  // server, anything else (or silence) a legacy one. The spec's version of "silence" is a timeout,
  // which a modern server behind a cold `npx` install would trip — so after a short wait
  // `initialize` goes out beside the still-pending probe, and a modern-only server's rejection of it
  // defers to whatever the probe answers.
  private async handshake(): Promise<void> {
    const probe = this.request(
      'server/discover',
      { _meta: this.requestMeta(MODERN_PROTOCOL_VERSION) },
      this.connectTimeoutMs,
      { cancel: false },
    ).then(
      result => ({ result }),
      (error: Error) => ({ error }),
    );
    const early = await Promise.race([
      probe,
      delay(Math.min(this.probeWaitMs, this.connectTimeoutMs)),
    ]);
    if (early) {
      if ('result' in early) return this.adoptModern(early.result);
      if (isModernError(early.error)) throw modernVersionError(early.error);
      if (this.exitError) throw this.exitError;
      return this.initializeLegacy();
    }
    try {
      await this.initializeLegacy();
    } catch (e) {
      if (this.exitError) throw e;
      const late = await probe;
      if ('result' in late) return this.adoptModern(late.result);
      if (isModernError(late.error)) throw modernVersionError(late.error);
      throw e;
    }
  }

  private async adoptModern(result: unknown): Promise<void> {
    const r = isRecord(result) ? result : {};
    const versions = Array.isArray(r.supportedVersions)
      ? r.supportedVersions.filter((v): v is string => typeof v === 'string')
      : [];
    if (!versions.includes(MODERN_PROTOCOL_VERSION)) {
      // A server that discovers but lists only handshake revisions is asking for the handshake.
      if (versions.some(v => LEGACY_VERSIONS.has(v))) return this.initializeLegacy();
      throw new Error(unsupportedVersionsText(versions));
    }
    this.era = 'modern';
    const meta = isRecord(r._meta) ? r._meta : {};
    const info = isRecord(meta['io.modelcontextprotocol/serverInfo'])
      ? meta['io.modelcontextprotocol/serverInfo']
      : {};
    this.server = {
      name: typeof info.name === 'string' ? info.name : '',
      ...(typeof info.version === 'string' ? { version: info.version } : {}),
      ...(typeof r.instructions === 'string' ? { instructions: r.instructions } : {}),
      protocol: MODERN_PROTOCOL_VERSION,
    };
  }

  private async initializeLegacy(): Promise<void> {
    const init = await this.request(
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        // `roots` is declared empty rather than absent: the server may ask, and answering "no
        // roots" is what keeps it from inventing a workspace of its own.
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: CLIENT_NAME, version: VERSION },
      },
      this.connectTimeoutMs,
      { cancel: false },
    );
    // The spec's "the client SHOULD disconnect" for a revision it does not speak. A server that
    // names none is taken at our word rather than refused over a missing field.
    const answered =
      isRecord(init) && typeof init.protocolVersion === 'string' ? init.protocolVersion : '';
    if (answered && !LEGACY_VERSIONS.has(answered)) {
      throw new Error(unsupportedVersionsText([answered]));
    }
    this.era = 'legacy';
    this.server = { ...readServerInfo(init), protocol: answered || LEGACY_PROTOCOL_VERSION };
    this.notify('notifications/initialized', {});
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
        this.connectTimeoutMs,
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
    let state: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(
        'tools/call',
        { name, arguments: args, ...(state !== undefined ? { requestState: state } : {}) },
        timeoutMs,
        { signal: opts.signal },
      );
      const r = isRecord(res) ? res : {};
      // A missing resultType is "complete" by the spec's rule for pre-2026 servers.
      if (r.resultType !== 'input_required') return r as McpCallResult;
      // reika declares no client capabilities, so a server asking for input (elicitation, sampling,
      // roots) is out of spec — but it is the server's call to fail, not something to retry.
      const asks = isRecord(r.inputRequests) ? Object.values(r.inputRequests) : [];
      if (asks.length > 0) {
        const methods = asks.map(a =>
          isRecord(a) && typeof a.method === 'string' ? a.method : '?',
        );
        throw new Error(`the tool asked for input reika cannot give (${methods.join(', ')})`);
      }
      if (attempt >= MAX_STATE_RETRIES) {
        throw new Error(`the tool asked to be called again ${attempt + 1} times without an answer`);
      }
      state = typeof r.requestState === 'string' ? r.requestState : undefined;
    }
  }

  // Resolves once the child is gone. Callers that are leaving anyway need not await it: the
  // pending exit keeps the event loop alive until the server has had its chance to exit on EOF.
  close(): Promise<void> {
    this.rejectInFlight(new Error('closed'));
    const child = this.child;
    this.child = undefined;
    // A child that already exited needs nothing, and ending its stdin would be a write to a
    // destroyed stream — the one thing this must not do on the way out.
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const timers: NodeJS.Timeout[] = [];
      child.once('exit', () => {
        for (const t of timers) clearTimeout(t);
        resolve();
      });
      child.stdin.end();
      timers.push(
        setTimeout(() => {
          child.kill('SIGTERM');
          timers.push(setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS));
        }, CLOSE_GRACE_MS),
      );
    });
  }

  // --- transport ---------------------------------------------------------------------------

  private start(): Promise<void> {
    const { command, args, env, cwd } = this.config;
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          ...(cwd ? { cwd } : {}),
          env: serverEnv(env),
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
        this.exitError = new Error(`could not start ${command}: ${e.message}`);
        this.rejectInFlight(this.exitError);
        reject(this.exitError);
      });
      child.on('exit', (code, signal) => {
        liveChildren.delete(child);
        this.exitError = new Error(
          `server exited (${signal ? `signal ${signal}` : `code ${code}`})${this.stderrSuffix()}`,
        );
        this.rejectInFlight(this.exitError);
      });
      liveChildren.add(child);
      resolve();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // Only the unterminated tail can be oversized: whole lines are consumed below as they arrive.
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_CHARS && !this.stdoutBuffer.includes('\n')) {
      debugLog(
        `[reika:debug] mcp ${this.name}: dropped a stdout line over ${MAX_STDOUT_LINE_CHARS} chars\n`,
      );
      this.stdoutBuffer = '';
      this.discardingLine = true;
      return;
    }
    if (this.discardingLine) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl === -1) {
        this.stdoutBuffer = '';
        return;
      }
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      this.discardingLine = false;
    }
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
    // A message with a method is the server's own request or notification, never our reply —
    // checked first, because a server numbers its requests from small integers too, and matching on
    // id alone let a server `ping` answer a pending `tools/call` of the same number.
    if (typeof msg.method === 'string') {
      const method = msg.method;
      if (id === undefined) {
        if (method === 'notifications/tools/list_changed') this.toolsChanged = true;
        return;
      }
      // A request FROM the server (legacy only; modern moved these into input_required results).
      // Answering is not optional — an unanswered request is how a server decides its peer is gone
      // — and there is nothing here to sample or to root, so the honest answer is an error for
      // anything beyond `ping` and an empty root list.
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
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return; // a late answer to a request already timed out or cancelled
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) entry.reject(new RpcError(msg.error));
    else entry.resolve(msg.result);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const { signal } = opts;
    if (this.exitError) return Promise.reject(this.exitError);
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const id = this.nextId++;
    const body = this.era === 'modern' ? { ...params, _meta: this.requestMeta() } : params;
    // An abandoned request is also cancelled: the server stops work nobody is waiting for (a spec
    // MUST on stdio since 2026-07-28, a SHOULD before), and a late answer is dropped by onMessage.
    const cancel = (reason: string): void => {
      if (opts.cancel !== false) this.notify('notifications/cancelled', { requestId: id, reason });
    };
    return new Promise((resolve, reject) => {
      // One request's bound, not the connection's: a timed-out call leaves the server running and
      // later calls work, which is the recovery a slow tool needs.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        cancel('timed out');
        reject(new Error(`no answer to ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      // An unref'd timer cannot hold the process open on its own; the child's pipes already do.
      timer.unref?.();
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        cancel('aborted by the user');
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
      this.send({ jsonrpc: '2.0', id, method, params: body });
    });
  }

  private requestMeta(version = MODERN_PROTOCOL_VERSION): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: CLIENT_NAME, version: VERSION },
    };
  }

  private notify(method: string, params: Record<string, unknown>): void {
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

export function serverEnv(own: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    // A value starting `()` is an exported bash function, which the SDKs also leave behind.
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  return { ...env, ...own };
}

function isModernError(e: Error): e is RpcError {
  return (
    e instanceof RpcError &&
    e.code !== undefined &&
    e.code >= MODERN_ERROR_MIN &&
    e.code <= MODERN_ERROR_MAX
  );
}

function modernVersionError(e: RpcError): Error {
  if (e.code !== UNSUPPORTED_PROTOCOL_VERSION) return e;
  const supported = isRecord(e.data) && Array.isArray(e.data.supported) ? e.data.supported : [];
  return new Error(
    unsupportedVersionsText(supported.filter((v): v is string => typeof v === 'string')),
  );
}

function unsupportedVersionsText(versions: string[]): string {
  return `server speaks protocol ${versions.join(', ') || '(none listed)'}; reika speaks ${MODERN_PROTOCOL_VERSION} and ${[...LEGACY_VERSIONS].join(', ')}`;
}

function delay(ms: number): Promise<undefined> {
  return new Promise(resolve => setTimeout(() => resolve(undefined), ms).unref());
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
