import { randomUUID } from 'node:crypto';
import { isStreamTimeout, streamDispatcher, streamTimeoutMessage } from './dispatcher.js';
import type { ToolParameters } from '../types.js';
import { API_USER_AGENT } from '../version.js';

// Minimal client for the OpenAI-compatible `/v1/chat/completions` streaming API.
//
// reika talks to a *wire format*, not a vendor SDK: llama.cpp, DeepSeek, Kimi, OpenRouter
// and OpenAI all speak this same protocol, and it is the de-facto-frozen lingua franca for
// local model servers. The `openai` npm package, by contrast, churns its API (and drags in
// legacy fetch shims). So we model the wire format directly here — the subset reika uses —
// and own the ~one POST + SSE decode that the SDK was doing for us. Everything reika-specific
// (tool-call dialect parsing, field unions, budgeting) was already our own code.
//
// Unknown response fields pass through harmlessly: we JSON.parse each frame and read only the
// fields we model, so a provider adding fields never breaks us.

// A multimodal user turn: text plus image parts. Built only for the *last* user message of a
// request, and only when the active profile sends pasted images natively (see VisionRoute) — the
// rest of the request stays string-only, which is what keeps the string-shaped machinery (aging,
// compaction, spill, transcripts) from ever having to reason about a non-string content field.
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessageParam =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
      // Non-OpenAI field: thinking models (DeepSeek/Kimi) round-trip prior reasoning here.
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string };

// The OpenAI multimodal shape for one image, as a base64 data URL. Shared by the two paths that
// put an image on the wire — the native send (provider/toolcall.ts) and the describe call
// (ocr/vision.ts) — so the two spellings can't drift.
export function imageContentPart(mime: string, bytes: Uint8Array): ChatContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` },
  };
}

export type ChatTool = {
  type: 'function';
  function: { name: string; description: string; parameters: ToolParameters };
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessageParam[];
  tools?: ChatTool[];
  stream: true;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  // Per-token logit offsets (token id → additive bias), applied for one request. Used only by the
  // last-resort rumination recovery to gently down-weight a looping model's repeated tokens before
  // the honest stop. Honored by llama.cpp/vllm; silently ignored by backends that don't support it
  // (e.g. Ollama's OpenAI shim) — harmless, the recovery is gated on /tokenize being reachable.
  logit_bias?: Record<number, number>;
  // Ask the engine to report per-token logprobs for the generated tokens, and the top-k
  // alternatives at each position. Sent only by the entropy/KL instrumentation (REIKA_ENTROPY,
  // issue #134). Honored by llama.cpp/vllm/OpenAI; backends that don't support it either ignore
  // the fields or reject the request, which client.ts degrades from (one retry without them).
  logprobs?: boolean;
  top_logprobs?: number;
  // `none` keeps the tool list in the request — and so in the prompt the template renders — while
  // forbidding a call. The report rounds (compaction note, subagent bounded return) use it instead
  // of sending no tools: templates render the list into the system turn (Qwen3.8 puts it BEFORE
  // the system prompt), so dropping it diverges the prompt from its first bytes and the round
  // re-prefills everything. Honored by llama.cpp/vllm/OpenAI; client.ts degrades from a rejection.
  tool_choice?: 'none';
  // Cache-routing hint, sent only to hosts that document it (provider/cachehints.ts). Carries the
  // process's SESSION_ID, the same id `x-session-id` sends.
  prompt_cache_key?: string;
  // Top-level cache breakpoint, sent only for Anthropic models on OpenRouter (provider/cachehints.ts).
  cache_control?: { type: 'ephemeral' };
};

// A streamed delta chunk. Field unions cover provider variants:
//   - reasoning lives in `reasoning_content` (DeepSeek/Kimi) or `reasoning` (OpenRouter)
//   - cache accounting in `prompt_tokens_details.cached_tokens` (OpenAI) or
//     `prompt_cache_hit_tokens` (DeepSeek)
// Modeling them here removes the `as`-casts client.ts used to reach past the SDK's types.
export type ChatCompletionChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    // Present only when the request set `logprobs` (and the engine supports it). One entry per
    // token in this chunk's delta, each with the sampled token's logprob and — when top_logprobs
    // was requested — the truncated candidate list at that position.
    logprobs?: {
      content?:
        | {
            token: string;
            logprob: number;
            top_logprobs?: { token: string; logprob: number }[] | null;
          }[]
        | null;
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
    prompt_cache_hit_tokens?: number | null;
  } | null;
};

// Matches the openai SDK's old default (2 retries) so behavior is unchanged: a transient
// connection error or 5xx/429 from a local server is quietly retried before it surfaces.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

// Status codes worth retrying: request timeout, conflict, rate limit, and the 5xx family.
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// POST the request, retrying transient failures *before* any body bytes are read — retrying
// after streaming starts would duplicate content, so retries only cover the connect/headers
// phase. Note: we deliberately impose no total-request timeout. The SDK's 10-min cap would
// kill a legitimately long local-model generation; a live stream keeps the socket fed, and
// user cancellation is handled by `signal`. (bash/fetch tools keep their own timeouts.)
//
// What we DO impose is a silent-stream timeout, via the dispatcher — without one, undici's 300 s
// default kills any turn whose prefill runs longer, which on slow local hardware is the normal
// path once context grows (issue #186). A stream timeout is never retried: the prompt hasn't
// changed, so a retry just buys the same silent wait again, three times over.
// One id per reika process, sent as `x-session-id` on every chat request that carries a key. Some
// hosted routers (OpenCode Go) refuse a request with no session id — they use it to pin a
// conversation to one backend so its prompt cache is reused — and accept this generic name
// alongside their own. The key is a proxy for "hosted": a keyed local server gets the header too
// and ignores it, while an unkeyed local request stays byte-identical to what it always was. Per
// process rather than per conversation on purpose: a /new on the same node costs nothing, and
// the id needs no plumbing through App. The same id goes out as `x-session-affinity`, Fireworks'
// name for the replica-routing hint that keeps a conversation's prompt cache warm.
export const SESSION_ID = randomUUID();

async function postWithRetry(
  url: string,
  body: ChatCompletionRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  const dispatcher = await streamDispatcher();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': API_USER_AGENT,
          ...(apiKey
            ? {
                Authorization: `Bearer ${apiKey}`,
                'x-session-id': SESSION_ID,
                'x-session-affinity': SESSION_ID,
              }
            : {}),
        },
        body: JSON.stringify(body),
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (res.ok && res.body) return res;
      if (attempt < MAX_RETRIES && isRetryableStatus(res.status)) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      const detail = await res.text().catch(() => '');
      throw new Error(
        `chat/completions failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw e;
      if (isStreamTimeout(e))
        throw new Error(`chat/completions timed out: ${streamTimeoutMessage()}`);
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export type SSEEvent = { kind: 'chunk'; chunk: ChatCompletionChunk } | { kind: 'done' };

// Incremental Server-Sent-Events decoder for the chat-completions stream. The fiddly,
// load-bearing part of owning the transport: network reads don't align to SSE frame or even
// UTF-8 boundaries, so we (a) decode bytes with a streaming TextDecoder (buffers a multibyte
// char split across two reads) and (b) buffer text until a complete `\n`-terminated line is
// available before parsing. Exported and pure (no I/O) so the framing is unit-testable by
// feeding arbitrarily-split byte fragments. See transport.test.ts.
export function createSSEDecoder(): {
  push(bytes: Uint8Array): SSEEvent[];
  flush(): SSEEvent[];
} {
  let buffer = '';
  const decoder = new TextDecoder();

  function drain(final: boolean): SSEEvent[] {
    const events: SSEEvent[] = [];
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      const ev = parseSSELine(line);
      if (ev) events.push(ev);
    }
    // On flush, a server that omits the trailing newline still gets its last frame parsed.
    if (final && buffer.trim()) {
      const ev = parseSSELine(buffer.trim());
      if (ev) events.push(ev);
      buffer = '';
    }
    return events;
  }

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      return drain(false);
    },
    flush() {
      buffer += decoder.decode();
      return drain(true);
    },
  };
}

// Parse one SSE line. Returns null for blanks, `:` keep-alive comments, and non-`data:`
// fields (`event:`/`id:`), so they're skipped. `data: [DONE]` ends the stream. A frame whose
// JSON won't parse is dropped rather than crashing the stream — a partial/garbled frame
// shouldn't kill an otherwise-good turn.
function parseSSELine(line: string): SSEEvent | null {
  if (!line || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return { kind: 'done' };
  if (!data) return null;
  try {
    return { kind: 'chunk', chunk: JSON.parse(data) as ChatCompletionChunk };
  } catch {
    return null;
  }
}

// Stream a chat completion as an async iterable of typed chunks. The caller accumulates
// deltas (content/reasoning/tool-calls) and reads usage/finish_reason off the chunks — same
// shape the SDK's stream yielded, so client.ts's consume loop is unchanged in spirit.
export async function* streamChatCompletion(opts: {
  baseURL: string;
  apiKey: string;
  body: ChatCompletionRequest;
  signal?: AbortSignal;
}): AsyncGenerator<ChatCompletionChunk> {
  // The wire endpoint is `<baseURL>/chat/completions`; baseURL already includes the `/v1`.
  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const res = await postWithRetry(url, opts.body, opts.apiKey, opts.signal);
  const reader = res.body!.getReader();
  const decoder = createSSEDecoder();
  try {
    for (;;) {
      // A mid-stream silence (the server stalled after some tokens) surfaces here rather than on
      // the POST, so it gets the same actionable message instead of a bare undici code.
      let read;
      try {
        read = await reader.read();
      } catch (e) {
        if (isStreamTimeout(e))
          throw new Error(`chat/completions stream stalled: ${streamTimeoutMessage()}`);
        throw e;
      }
      const { done, value } = read;
      if (done) break;
      for (const ev of decoder.push(value)) {
        if (ev.kind === 'done') return;
        yield ev.chunk;
      }
    }
    for (const ev of decoder.flush()) {
      if (ev.kind === 'done') return;
      yield ev.chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

// llama.cpp serves a native `/tokenize` at the server ROOT, not under `/v1` (unlike chat/completions,
// which the SDK appends `/chat/completions` to). Strip a trailing `/v1` so the same configured baseURL
// reaches both.
function tokenizeEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')}/tokenize`;
}

// Tokenize text into the model's vocab ids via llama.cpp's `/tokenize`. Returns null on any failure —
// a non-llama.cpp backend (no such endpoint), a non-2xx, a shape we don't recognize, or a network
// error — so the caller treats "can't tokenize" as "logit-bias recovery unavailable" and falls
// through to the honest stop. Never throws; this is a best-effort last resort, not a hot path.
export async function tokenize(opts: {
  baseURL: string;
  apiKey: string;
  content: string;
  signal?: AbortSignal;
}): Promise<number[] | null> {
  try {
    const res = await fetch(tokenizeEndpoint(opts.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': API_USER_AGENT,
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      // add_special:false so no BOS/special token is prepended — the first returned id is the actual
      // first token of the content, which the bias logic relies on (the "entry token" of a word).
      body: JSON.stringify({ content: opts.content, add_special: false }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    // Default llama.cpp shape is `{ tokens: number[] }`. (With `with_pieces` it's objects — we don't
    // request that, so plain numbers.) Anything else → treat as unsupported.
    const data = (await res.json()) as { tokens?: unknown };
    if (!Array.isArray(data.tokens)) return null;
    const ids = data.tokens.filter((t): t is number => typeof t === 'number');
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}
