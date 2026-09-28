import { debugLog } from '../debug.js';
import { rootMessage } from '../tools/_net.js';
import { SearchUnavailableError } from './types.js';
import { WEB_USER_AGENT } from '../version.js';
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
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: { Accept: 'application/json', 'User-Agent': WEB_USER_AGENT },
          signal: controller.signal,
        });
      } catch (e) {
        // The instance itself could not be reached — refused, unresolvable, timed out. That is a
        // property of the provider, not the query: there is one host, and rewording the query
        // does not bring it up. Raised as unavailable so the tool latches the turn instead of
        // letting the model spend three searches finding out the same thing three times (#392).
        const detail = controller.signal.aborted
          ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s`
          : rootMessage(e);
        throw new SearchUnavailableError(
          `SearXNG at ${this.baseUrl} could not be reached (${detail})`,
          `SearXNG at ${this.baseUrl} did not answer (${detail}). Check that the instance is running and reachable, or set REIKA_CDP_SEARCH=1 (with Chrome installed) to search through Chrome instead.`,
        );
      }
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
        throw new SearchUnavailableError(
          `every SearXNG engine was unavailable (${down})`,
          'Every engine this SearXNG instance tried refused the request. REIKA_CDP_SEARCH=1 (with Chrome installed) drives a real Chrome instead, which keeps being served where a bare HTTP client is blocked.',
        );
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
