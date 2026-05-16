import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearxngProvider } from './searxng.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('SearxngProvider', () => {
  it('GETs /search with q and format=json', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const provider = new SearxngProvider('http://localhost:8888');
    await provider.search('hello');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/search');
    expect(parsed.searchParams.get('q')).toBe('hello');
    expect(parsed.searchParams.get('format')).toBe('json');
  });

  it('handles base URLs without trailing slash', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const provider = new SearxngProvider('http://localhost:8888');
    await provider.search('q');
    const [url] = fetchMock.mock.calls[0];
    expect(url as string).toContain('/search?');
  });

  it('normalizes results and preserves engine as source', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockResponse({
        results: [
          { title: 'A', url: 'https://a.example', content: 'snip A', engine: 'duckduckgo' },
          { title: 'B', url: 'https://b.example', content: 'snip B', engine: 'wikipedia' },
        ],
      }),
    );
    const provider = new SearxngProvider('http://localhost:8888');
    const out = await provider.search('q');
    expect(out).toEqual([
      { title: 'A', url: 'https://a.example', snippet: 'snip A', source: 'duckduckgo' },
      { title: 'B', url: 'https://b.example', snippet: 'snip B', source: 'wikipedia' },
    ]);
  });

  it('caps results to maxResults', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockResponse({
        results: Array.from({ length: 20 }, (_, i) => ({
          title: `T${i}`,
          url: `https://${i}`,
          content: '',
        })),
      }),
    );
    const provider = new SearxngProvider('http://localhost:8888');
    const out = await provider.search('q', { maxResults: 5 });
    expect(out).toHaveLength(5);
  });

  it('throws on non-OK response', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({}, false, 403));
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).rejects.toThrow(/403/);
  });
});
