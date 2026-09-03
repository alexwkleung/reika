import { debugLog } from '../debug.js';
import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;

type SearxngResult = {
  title: string;
  url: string;
  content?: string;
  engine?: string;
};

type SearxngResponse = {
  results?: SearxngResult[];
  // Pairs of [engine, reason], e.g. ["duckduckgo", "CAPTCHA"]. SearXNG answers 200 with an empty
  // `results` when every engine it tried was blocked, so this field is the only thing separating
  // "the web has nothing" from "we were turned away at the door".
  unresponsive_engines?: unknown[];
};

export class SearxngProvider implements SearchProvider {
  constructor(private baseUrl: string) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const url = new URL('/search', ensureTrailingSlash(this.baseUrl));
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`SearXNG ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as SearxngResponse;
      const max = opts.maxResults ?? 8;
      const results = (data.results ?? []).slice(0, max).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        source: r.engine,
      }));

      const down = formatUnresponsive(data.unresponsive_engines);
      if (down) debugLog(`[searxng] unresponsive engines: ${down} (results=${results.length})`);

      // An empty result set with dead engines is a failed search, not an answered one. Reporting it
      // as "no results" tells the model its *query* was bad, so it rewords and tries again — a spiral
      // that burns the turn's search budget while every attempt is refused for the same reason.
      // Raising here routes it through the tool's failure path, where the cause is stated instead.
      if (results.length === 0 && down) {
        throw new Error(`every SearXNG engine was unavailable (${down})`);
      }

      return results;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Defensive about shape: the entries are [engine, reason] pairs today, but a bare engine name or a
// longer tuple has to degrade to a readable line rather than "[object Object]" in the model's view.
function formatUnresponsive(entries: unknown[] | undefined): string {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map(entry => {
      if (typeof entry === 'string') return entry;
      if (!Array.isArray(entry)) return '';
      const [engine, reason] = entry;
      const name = typeof engine === 'string' ? engine : '';
      const why = typeof reason === 'string' ? reason : '';
      if (!name) return '';
      return why ? `${name}: ${why}` : name;
    })
    .filter(Boolean)
    .join('; ');
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}
