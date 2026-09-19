// Context-window fallback (#417): when REIKA_CONTEXT_WINDOW is unset, ask the endpoint. Every
// window-driven layer (compaction, the fit-to-window cap, the generation backstop, prefix-stable
// mode) is inert without a window, and a llama-server already knows its own — so a user running
// on defaults gets the discipline without copying a number out of their server flags.
//
// Read off `GET {baseURL}/models`, per entry:
//   - llama.cpp: `meta.n_ctx` — the slot's size (what `-c`/`-np` actually leave a request), NOT
//     `meta.n_ctx_train`, which is the model's trained length and would claim 131k on a server
//     started with `-c 24576`, after which nothing ever compacts and the request 400s.
//   - vLLM: `max_model_len`.
//   - `context_length`: the generic spelling some proxies use.
// A server that reports none of these (Ollama's shim, OpenAI, a bare router) yields undefined and
// nothing changes — the gauge shows absolute tokens as before. Never throws; startup must not
// depend on a network round trip succeeding.

const PROBE_TIMEOUT_MS = 3000;
// Floored to the thousand below (24555 → 24000): the window bounds a budget, and a round number
// under the real one is a margin, where one over it is a 400.
const WINDOW_GRANULARITY = 1000;

type ModelEntry = {
  id?: unknown;
  aliases?: unknown;
  context_length?: unknown;
  max_model_len?: unknown;
  meta?: { n_ctx?: unknown };
};

export function floorContextWindow(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  const floored = Math.floor(n / WINDOW_GRANULARITY) * WINDOW_GRANULARITY;
  return floored > 0 ? floored : undefined;
}

// Picks the entry for `model` — by id, then by llama.cpp's `aliases` — and falls back to a lone
// entry: a single-model llama-server serves whatever it loaded regardless of the name requested,
// and listing it under the GGUF's alias while REIKA_MODEL says something else is the common case.
// A multi-model listing with no match reports nothing: guessing a neighbour's window is worse
// than none.
export function parseContextWindow(body: unknown, model: string): number | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const entries = data.filter((e): e is ModelEntry => typeof e === 'object' && e !== null);
  const entry =
    entries.find(e => e.id === model) ??
    entries.find(e => Array.isArray(e.aliases) && e.aliases.includes(model)) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (!entry) return undefined;
  for (const raw of [entry.meta?.n_ctx, entry.max_model_len, entry.context_length]) {
    if (typeof raw === 'number') return floorContextWindow(raw);
  }
  return undefined;
}

export async function probeContextWindow(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
}): Promise<number | undefined> {
  try {
    const res = await fetch(`${opts.baseURL.replace(/\/+$/, '')}/models`, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return parseContextWindow(await res.json(), opts.model);
  } catch {
    return undefined;
  }
}
