import type { ServerEvent } from '../protocol.js';

// Reads GET /events with fetch, never EventSource: the token goes in an Authorization header, and
// EventSource can set no header, so it would need the token in the URL. A dropped stream is
// reopened from the newest seq the tab took, sent as Last-Event-ID.

export type SseFrame = { data: string; id?: string; event?: string };

export type SseParse = { frames: SseFrame[]; rest: string };

// Pure: hand back `rest` with the next chunk. A trailing CR is held, since its LF may be in the
// next chunk and CRLF must not read as two line ends.
export function parseSseChunk(rest: string, chunk: string): SseParse {
  let text = rest + chunk;
  let held = '';
  if (text.endsWith('\r')) {
    held = '\r';
    text = text.slice(0, -1);
  }
  text = text.replace(/\r\n?/g, '\n');
  const frames: SseFrame[] = [];
  let end: number;
  while ((end = text.indexOf('\n\n')) !== -1) {
    const block = text.slice(0, end);
    text = text.slice(end + 2);
    const frame = parseBlock(block);
    if (frame) frames.push(frame);
  }
  return { frames, rest: text + held };
}

function parseBlock(block: string): SseFrame | null {
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'event') event = value;
  }
  // The spec dispatches nothing for a block with no data line (a heartbeat is a comment).
  if (data.length === 0) return null;
  return {
    data: data.join('\n'),
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
  };
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'signed-out';

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

// The server pings every 15s (DEFAULT_HEARTBEAT_MS in server.ts); three missed pings is a dead
// stream that never errored, such as a laptop that slept.
export const STALL_MS = 45_000;

export const MAX_BACKOFF_MS = 10_000;

export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
}

export type EventStreamOptions = {
  token: string;
  resumeFrom: () => number | null;
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: StreamStatus) => void;
  fetch?: typeof fetch;
  timers?: Timers;
  stallMs?: number;
};

export type EventStream = { close(): void };

export function openEventStream(opts: EventStreamOptions): EventStream {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timers: Timers = opts.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const stallMs = opts.stallMs ?? STALL_MS;
  let closed = false;
  let attempt = 0;
  let abort: AbortController | null = null;
  let stallTimer: unknown = null;
  let retryTimer: unknown = null;

  const status = (s: StreamStatus): void => {
    if (!closed) opts.onStatus(s);
  };

  const armStall = (controller: AbortController): void => {
    if (stallTimer !== null) timers.clearTimeout(stallTimer);
    stallTimer = timers.setTimeout(() => controller.abort(), stallMs);
  };
  const disarmStall = (): void => {
    if (stallTimer !== null) timers.clearTimeout(stallTimer);
    stallTimer = null;
  };

  const retry = (): void => {
    if (closed) return;
    status('reconnecting');
    const wait = backoffMs(attempt++);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, wait);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const controller = new AbortController();
    abort = controller;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
    const after = opts.resumeFrom();
    if (after !== null) headers['Last-Event-ID'] = String(after);
    // Armed before the request: a server that accepts the socket and never answers is a stall too.
    armStall(controller);
    try {
      const res = await fetchFn('/events', {
        headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (res.status === 401) {
        disarmStall();
        status('signed-out');
        closed = true;
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream refused (${res.status})`);
      status('open');
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall(controller);
        const parsed = parseSseChunk(rest, decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        for (const frame of parsed.frames) {
          let event: ServerEvent;
          try {
            event = JSON.parse(frame.data) as ServerEvent;
          } catch {
            continue;
          }
          if (closed) return;
          opts.onEvent(event);
        }
      }
    } catch {
      // Falls through to the reconnect: an abort, a reset socket or a refused stream.
    } finally {
      disarmStall();
      if (abort === controller) abort = null;
    }
    retry();
  };

  status('connecting');
  void connect();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      disarmStall();
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      abort?.abort();
    },
  };
}
