import { networkInterfaces } from 'node:os';

// Error codes that mean the NETWORK is down, not the host: name resolution failed outright, or no
// route exists. A refused connection, a timeout, a TLS failure all name one server's condition and
// stay per-call — one slow host is not an outage, and a model told "offline" over a single bad
// server would give up on the next perfectly good URL. This set is what the fetch tool latches a
// turn on (#392): every further web call would fail the same way, so none of them is worth the
// round it costs.
const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
]);

// The `code` on an error or any of its causes. undici wraps a socket failure as
// `TypeError: fetch failed` with the real error on `cause`, so the top-level message alone says
// nothing a model can act on; the code is one level down.
export function errorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// The offline code out of an error, or undefined when the failure is host-specific.
export function offlineCode(e: unknown): string | undefined {
  const code = errorCode(e);
  return code && OFFLINE_CODES.has(code) ? code : undefined;
}

// The innermost message of an error chain, for a failure text that names the cause rather than
// undici's outer "fetch failed".
export function rootMessage(e: unknown): string {
  let cur: unknown = e;
  let msg = '';
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const m = (cur as { message?: unknown }).message;
    if (typeof m === 'string' && m) msg = m;
    cur = (cur as { cause?: unknown }).cause;
  }
  return msg || String(e);
}

// Whether this machine has any route out at all: an interface with a non-loopback, non-link-local
// address. Zero egress — no probe request — so it costs nothing on an airgapped machine and leaks
// nothing to anyone. It answers the common case (wifi off, airplane mode) and nothing subtler: a
// connected router with no upstream reads as online, and the per-turn latch above catches that
// one on the first failed call. Link-local is excluded on purpose — macOS keeps fe80:: on utun and
// awdl interfaces with the radio off, so counting it would never say offline.
export function isOffline(interfaces = networkInterfaces()): boolean {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' && a.address.startsWith('169.254.')) continue;
      if (a.family === 'IPv6' && /^fe[89ab]/i.test(a.address)) continue;
      return false;
    }
  }
  return true;
}
