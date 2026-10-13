// Model limits from the models.dev catalog, for hosted endpoints whose `/models` listing carries
// no window (OpenCode Go, OpenRouter, most OpenAI-shaped routers). The endpoint probe (#417) still
// goes first: a server's own number describes what it serves, a catalog's is a claim about it.
//
// Two numbers come back per model. The window feeds everything #417's does. The output limit is
// the one the endpoint probe never had: the backstop sends `window − prompt − margin`, which on a
// 300k window is ~295k — over most hosted models' output cap, and rejected as too large.
//
// The catalog is matched by the provider's `api` base URL, never by model id alone: a local
// `qwen3.8-27b` served at `-c 24576` shares its id with a hosted entry claiming 262k, and the
// neighbour's number would be the 400 this exists to prevent. Loopback and private hosts are never
// looked up, so a local-only setup makes no request to models.dev.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyPrivateUrl } from '../tools/_hosts.js';
import { API_USER_AGENT } from '../version.js';
import { floorContextWindow, probeContextWindow } from './contextwindow.js';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';
export const MODEL_CATALOG_CACHE_PATH = join(homedir(), '.config', 'reika', 'model-limits.json');
// A day: the catalog moves when providers add models, not per session, and a stale answer is
// still an answer — a refresh failure keeps serving the old file.
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
// The full catalog is ~5MB; only a first-ever run waits on it.
const CATALOG_FETCH_TIMEOUT_MS = 8000;

export type ModelLimits = { window?: number; maxOutput?: number };
// normalized api base URL → model id → limits. What the cache file holds: ~400KB against the raw
// catalog's ~5MB of pricing and modality metadata nothing here reads.
export type CatalogIndex = Record<string, Record<string, ModelLimits>>;

export function normalizeApiBase(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

export function isCatalogEligible(baseURL: string): boolean {
  try {
    new URL(baseURL);
  } catch {
    return false;
  }
  return classifyPrivateUrl(baseURL) === undefined;
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

// `limit.input` is set where the prompt cap is below the total (gpt-5.x: 922k of 1.05M), and the
// window here bounds the prompt, so the smaller of the two is the honest one.
export function indexCatalog(body: unknown): CatalogIndex {
  const index: CatalogIndex = {};
  if (!body || typeof body !== 'object') return index;
  for (const provider of Object.values(body as Record<string, unknown>)) {
    const p = provider as { api?: unknown; models?: unknown } | null;
    if (typeof p?.api !== 'string' || !p.models || typeof p.models !== 'object') continue;
    const models = (index[normalizeApiBase(p.api)] ??= {});
    for (const [id, entry] of Object.entries(p.models as Record<string, unknown>)) {
      if (models[id]) continue;
      const limit = (entry as { limit?: Record<string, unknown> } | null)?.limit;
      const context = positive(limit?.context);
      const input = positive(limit?.input);
      const bound = context && input ? Math.min(context, input) : (context ?? input);
      const limits: ModelLimits = {
        window: bound ? floorContextWindow(bound) : undefined,
        maxOutput: positive(limit?.output),
      };
      if (limits.window || limits.maxOutput) models[id] = limits;
    }
  }
  return index;
}

export function lookupModelLimits(
  index: CatalogIndex,
  baseURL: string,
  model: string,
): ModelLimits | undefined {
  return index[normalizeApiBase(baseURL)]?.[model];
}

function readCache(path: string): { index: CatalogIndex; fresh: boolean } | undefined {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const index = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!index || typeof index !== 'object') return undefined;
    return { index: index as CatalogIndex, fresh: age < CATALOG_TTL_MS };
  } catch {
    return undefined;
  }
}

async function fetchCatalog(path: string): Promise<CatalogIndex | undefined> {
  try {
    const res = await fetch(MODEL_CATALOG_URL, {
      headers: { 'User-Agent': API_USER_AGENT },
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const index = indexCatalog(await res.json());
    if (Object.keys(index).length === 0) return undefined;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, path);
    } catch {
      // An unwritable config dir costs a refetch next session, not this answer.
    }
    return index;
  } catch {
    return undefined;
  }
}

// Stale-while-revalidate: a stale cache answers now and refreshes behind it, so only a machine
// that has never fetched the catalog waits on the download. Never throws.
export async function loadModelCatalog(
  path = MODEL_CATALOG_CACHE_PATH,
): Promise<CatalogIndex | undefined> {
  const cached = readCache(path);
  if (cached?.fresh) return cached.index;
  if (cached) {
    void fetchCatalog(path);
    return cached.index;
  }
  return fetchCatalog(path);
}

// Catalog bases on the same host as `baseURL`, other than itself. A provider that moves its API
// path (models.dev's opencode-go went from /zen/go/v1 to /inference/go/v1) leaves a profile on the
// old base with no entry, and the new base is what the user needs to see. Named, never used: two
// bases on one host can be two products, so picking one would be a guess.
export function sameHostBases(index: CatalogIndex, baseURL: string): string[] {
  let host: string;
  try {
    host = new URL(baseURL).host.toLowerCase();
  } catch {
    return [];
  }
  const own = normalizeApiBase(baseURL);
  return Object.keys(index)
    .filter(base => base !== own && hostOf(base) === host)
    .sort();
}

function hostOf(base: string): string | undefined {
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return undefined;
  }
}

// Why the catalog gave no window, for the notice: a miss that reads as "no window" alone sent a
// user hunting a local-server fix for a provider that had moved its URL.
export type CatalogMiss = {
  // The base is in the catalog but this model is not under it.
  baseListed: boolean;
  sameHost: string[];
};

export type ModelLimitsProbe = ModelLimits & {
  // Where the window came from, for the notice: the user is told which number governs the session.
  windowSource?: 'endpoint' | 'catalog';
  // The endpoint probe's `reached` (#417): false only when the window was asked for and nothing
  // answered, which is what the per-submit retry keys on.
  reached: boolean;
  // Set when the catalog was consulted for a window and had none for this base and model.
  catalogMiss?: CatalogMiss;
};

// What startup and a /model switch need to ask about. An explicit window still leaves the output
// limit open — the case the catalog exists for — but only a catalog-eligible host can answer it,
// so a local server with REIKA_CONTEXT_WINDOW set sees no request at all.
export function needsLimitsProbe(profile: {
  baseURL: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}): boolean {
  if (profile.contextWindow == null) return true;
  return profile.maxOutputTokens == null && isCatalogEligible(profile.baseURL);
}

export async function probeModelLimits(
  profile: {
    baseURL: string;
    apiKey: string;
    model: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  },
  catalog: () => Promise<CatalogIndex | undefined> = loadModelCatalog,
): Promise<ModelLimitsProbe> {
  const probe: ModelLimitsProbe = { reached: true };
  if (profile.contextWindow == null) {
    const endpoint = await probeContextWindow(profile);
    probe.reached = endpoint.reached;
    if (endpoint.window) {
      probe.window = endpoint.window;
      probe.windowSource = 'endpoint';
    }
  }
  const wantWindow = profile.contextWindow == null && probe.window == null;
  const wantOutput = profile.maxOutputTokens == null;
  if (!(wantWindow || wantOutput) || !isCatalogEligible(profile.baseURL)) return probe;
  const index = await catalog();
  const found = index && lookupModelLimits(index, profile.baseURL, profile.model);
  if (index && wantWindow && !found?.window) {
    probe.catalogMiss = {
      baseListed: index[normalizeApiBase(profile.baseURL)] !== undefined,
      sameHost: sameHostBases(index, profile.baseURL),
    };
  }
  if (!found) return probe;
  if (wantWindow && found.window) {
    probe.window = found.window;
    probe.windowSource = 'catalog';
  }
  if (wantOutput && found.maxOutput) probe.maxOutput = found.maxOutput;
  return probe;
}
