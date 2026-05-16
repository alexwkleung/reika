import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavilyProvider } from './tavily.js';

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

describe('TavilyProvider', () => {
  it('POSTs to api.tavily.com with the api key and query in the body', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const provider = new TavilyProvider('test-key');
    await provider.search('hello world');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    const init = opts as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe('test-key');
    expect(body.query).toBe('hello world');
    expect(body.max_results).toBe(8);
  });

  it('honors a custom maxResults', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const provider = new TavilyProvider('k');
    await provider.search('x', { maxResults: 3 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.max_results).toBe(3);
  });

  it('normalizes API results to SearchResult shape', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockResponse({
        results: [
          { title: 'A', url: 'https://a.example', content: 'snippet A' },
          { title: 'B', url: 'https://b.example', content: 'snippet B' },
        ],
      }),
    );
    const provider = new TavilyProvider('k');
    const out = await provider.search('q');
    expect(out).toEqual([
      { title: 'A', url: 'https://a.example', snippet: 'snippet A' },
      { title: 'B', url: 'https://b.example', snippet: 'snippet B' },
    ]);
  });

  it('returns [] when API returns no results', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({}));
    const provider = new TavilyProvider('k');
    const out = await provider.search('q');
    expect(out).toEqual([]);
  });

  it('throws on non-OK response', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({}, false, 403));
    const provider = new TavilyProvider('k');
    await expect(provider.search('q')).rejects.toThrow(/403/);
  });
});
