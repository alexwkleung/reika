import { debugLog } from '../debug.js';

// Why this file exists: Node's global `fetch` is undici, and undici's defaults abort any request
// whose stream goes quiet for 300 s (`headersTimeout` and `bodyTimeout`, both 300_000). That is a
// sane default for a web client and a wrong one for a local model server: llama.cpp emits nothing
// at all while it prefills, so a large prompt on slow hardware looks byte-for-byte like a hung
// server. Measured at ~23 tok/s prefill on an M2 16GB, a 6.5k-token prompt spends ~5.5 min silent
// and gets killed mid-prefill — and the wall-clock cost only grows as the context window fills
// (issue #186). The fix is one dispatcher with raised stream timeouts, used for the chat stream.
//
// Reaching undici without depending on it: `fetch(url, { dispatcher })` is honored by Node's
// built-in fetch, and the running Agent is parked on a well-known global symbol — the same symbol
// npm `undici`'s `setGlobalDispatcher` writes to in order to steer core fetch. Borrowing that
// object's constructor gets us *exactly* the undici the runtime already loaded, with no new
// dependency and no version skew. If any of it is missing (a future Node, another runtime), we
// fall open to bare fetch: the old 300 s behavior, never a crash.

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

// 30 minutes. Generous enough to cover a full re-prefill near the context window on slow local
// hardware (~17.5 min for 24k tokens at 23 tok/s), short enough that a genuinely hung server still
// fails on its own rather than wedging the session forever.
export const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000;

// `REIKA_REQUEST_TIMEOUT_MS` in ms; `0` disables the stream timeouts entirely (undici's own
// meaning for 0). Anything unparseable or negative falls back to the default rather than
// surprising the user with an instant-abort typo.
export function requestTimeoutMs(): number {
  const raw = (process.env.REIKA_REQUEST_TIMEOUT_MS ?? '').trim();
  if (raw === '') return DEFAULT_REQUEST_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.floor(n);
}

// The dispatcher is opaque to us — we only hand it straight back to `fetch`. Typed structurally
// rather than as `RequestInit['dispatcher']` because the ambient `RequestInit` in this project is
// the DOM one (jsdom's lib is in scope), which has no such field; Node honors it regardless.
export type FetchDispatcher = { readonly dispatch: unknown };
type AgentCtor = new (opts: { headersTimeout: number; bodyTimeout: number }) => FetchDispatcher;

// Undici's default, used only to describe the failure honestly when we could NOT install our own
// dispatcher and the runtime's own limit is what fired.
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;

let cached: { dispatcher: FetchDispatcher | undefined; timeoutMs: number } | null = null;

// The Agent class of the dispatcher Node is already using. A `data:` fetch initializes undici's
// fetch machinery (and with it the global dispatcher) without opening a socket or resolving DNS,
// so this is safe to call before the first real request.
async function agentConstructor(): Promise<AgentCtor | null> {
  const g = globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>;
  if (!g[GLOBAL_DISPATCHER]) await fetch('data:text/plain,').catch(() => {});
  // A plain `Agent` only. If someone installed a ProxyAgent/MockAgent globally, cloning its class
  // with our options would silently drop their proxy or mock config — leave that setup alone and
  // fall open instead.
  const ctor = g[GLOBAL_DISPATCHER]?.constructor;
  if (typeof ctor !== 'function' || ctor.name !== 'Agent') return null;
  return ctor as AgentCtor;
}

// The dispatcher for chat-completion requests, built once and reused so connections stay pooled
// across rounds. `undefined` means "couldn't build one" — callers then just omit the option.
export async function streamDispatcher(): Promise<FetchDispatcher | undefined> {
  if (cached) return cached.dispatcher;
  const timeoutMs = requestTimeoutMs();
  let dispatcher: FetchDispatcher | undefined;
  try {
    const Agent = await agentConstructor();
    if (Agent) dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  } catch (e) {
    dispatcher = undefined;
    debugLog(
      `[reika:debug] request-timeout dispatcher unavailable, using undici defaults ` +
        `(${e instanceof Error ? e.message : String(e)})\n`,
    );
  }
  cached = { dispatcher, timeoutMs };
  debugLog(
    `[reika:debug] request-timeout installed=${dispatcher ? 1 : 0} ` +
      `timeoutMs=${dispatcher ? timeoutMs : UNDICI_DEFAULT_TIMEOUT_MS}\n`,
  );
  return dispatcher;
}

// Tests only: drop the memoized dispatcher so a different REIKA_REQUEST_TIMEOUT_MS takes effect.
export function resetStreamDispatcher(): void {
  cached = null;
}

// Undici reports a stream timeout as UND_ERR_HEADERS_TIMEOUT (nothing arrived before the response
// headers) or UND_ERR_BODY_TIMEOUT (the body went quiet mid-stream). Before the headers land,
// fetch wraps it in a `TypeError: fetch failed` whose `cause` carries the code; a mid-stream one
// surfaces on the reader directly. Check both shapes.
export function isStreamTimeout(e: unknown): boolean {
  const codes = ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
  const code = (x: unknown): string | undefined =>
    typeof x === 'object' &&
    x !== null &&
    'code' in x &&
    typeof (x as { code: unknown }).code === 'string'
      ? (x as { code: string }).code
      : undefined;
  const cause =
    typeof e === 'object' && e !== null && 'cause' in e
      ? (e as { cause: unknown }).cause
      : undefined;
  return codes.includes(code(e) ?? '') || codes.includes(code(cause) ?? '');
}

// One sentence the user can act on, naming the limit that actually fired — ours, or undici's when
// we couldn't install a dispatcher.
export function streamTimeoutMessage(): string {
  const installed = !!cached?.dispatcher;
  const ms = installed ? (cached?.timeoutMs ?? requestTimeoutMs()) : UNDICI_DEFAULT_TIMEOUT_MS;
  const which = installed
    ? 'REIKA_REQUEST_TIMEOUT_MS'
    : "undici's default (reika could not install its own dispatcher on this runtime)";
  return (
    `the server sent nothing for ${Math.round(ms / 1000)}s and the request was aborted by ${which}. ` +
    `A local model still prefilling a large prompt looks exactly like this — raise ` +
    `REIKA_REQUEST_TIMEOUT_MS (ms), or set it to 0 to wait indefinitely.`
  );
}
