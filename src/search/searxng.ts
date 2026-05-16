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
      return (data.results ?? []).slice(0, max).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        source: r.engine,
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}
