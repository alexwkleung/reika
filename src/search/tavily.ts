import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 10_000;

type TavilyResult = {
  title: string;
  url: string;
  content: string;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

export class TavilyProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: opts.maxResults ?? 8,
          search_depth: 'basic',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Tavily ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as TavilyResponse;
      return (data.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}
