import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearxngProvider } from './searxng.js';
import { SearchUnavailableError } from './types.js';
import { WEB_USER_AGENT } from '../version.js';

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

// #164 gave extractUrl a host policy that refuses loopback and LAN addresses. The search provider
// is deliberately outside it — its address comes from REIKA_SEARXNG_URL, which the user set, and a
// local-first instance is EXPECTED on loopback. That exemption is stated in AGENTS.md, so it is
// pinned here too: "unify every fetch through extractUrl" should fail a test rather than silently
// break local search, which is the documented default setup.
describe('SearxngProvider — outside the extractUrl host policy', () => {
  const loopback = [
    'http://localhost:8888',
    'http://127.0.0.1:8888',
    'http://192.168.1.50:8888', // a LAN instance is as legitimate as a loopback one
  ];

  for (const base of loopback) {
    it(`reaches a private-address instance at ${base}`, async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(
        mockResponse({ results: [{ title: 'r', url: 'https://example.com', content: 'x' }] }),
      );
      const results = await new SearxngProvider(base).search('hello');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain(new URL(base).host);
      expect(results).toHaveLength(1);
    });
  }

  it('calls fetch directly rather than routing through extractUrl', async () => {
    // The structural half of the claim: the provider issues its own request with an Accept header
    // and its own timeout signal, which is what keeps it off the policed path. If this ever starts
    // going through extractUrl, the loopback cases above stop passing.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    await new SearxngProvider('http://127.0.0.1:8888').search('q');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Accept: 'application/json', 'User-Agent': WEB_USER_AGENT },
    });
  });
});

// The instance that prompted this: SearXNG answers 200 with `results: []` and every engine listed
// as blocked. Returning that as an ordinary empty array made the tool say "No results for <query>",
// which reads as a bad query — so the model rewords and re-searches until the turn's budget is gone.
describe('SearxngProvider — blocked engines are a failure, not an empty result set', () => {
  const allBlocked = {
    results: [],
    unresponsive_engines: [
      ['brave', 'Suspended: too many requests'],
      ['duckduckgo', 'CAPTCHA'],
      ['qwant', 'Suspended: access denied'],
      ['startpage', 'Suspended: CAPTCHA'],
    ],
  };

  it('throws naming the engines when every engine is down and nothing came back', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse(allBlocked));
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).rejects.toThrow(
      /every SearXNG engine was unavailable.*duckduckgo: CAPTCHA/,
    );
  });

  // Typed, not a bare Error: the tool latches on this class specifically, so a plain throw here
  // would silently turn a turn-wide block back into three separate reworded attempts.
  it('raises the typed provider-level failure, carrying the remedy for the user', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse(allBlocked));
    const provider = new SearxngProvider('http://localhost:8888');
    const err = await provider.search('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect((err as SearchUnavailableError).remedy).toMatch(/REIKA_CDP_SEARCH=1/);
  });

  // #392: the instance itself unreachable is a provider condition — one host, and rewording the
  // query does not bring it up — so it takes the same typed failure and latches the turn.
  it('raises the typed failure when the instance cannot be reached, naming the cause', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8888'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );
    const provider = new SearxngProvider('http://localhost:8888');
    const err = await provider.search('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect((err as Error).message).toBe(
      'SearXNG at http://localhost:8888 could not be reached (connect ECONNREFUSED 127.0.0.1:8888)',
    );
    expect((err as SearchUnavailableError).remedy).toMatch(
      /running and reachable.*REIKA_CDP_SEARCH=1/,
    );
  });

  it('keeps an error response from the instance query-level', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({}, false, 500));
    const provider = new SearxngProvider('http://localhost:8888');
    const err = await provider.search('q').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SearchUnavailableError);
    expect((err as Error).message).toMatch(/SearXNG 500/);
  });

  it('still reports a genuine zero-result search as empty, not as a failure', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [], unresponsive_engines: [] }));
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).resolves.toEqual([]);
  });

  it('treats a missing unresponsive_engines field as a genuine zero-result search', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).resolves.toEqual([]);
  });

  it('returns results when only some engines are down — partial degradation is not a failure', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockResponse({
        results: [{ title: 'A', url: 'https://a.example', content: 'snip', engine: 'wikipedia' }],
        unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
      }),
    );
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).resolves.toHaveLength(1);
  });

  it('degrades unexpected unresponsive_engines shapes to readable text', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      mockResponse({
        results: [],
        // A bare name, a pair, and junk: the message has to stay legible for the model reading it.
        unresponsive_engines: ['mojeek', ['brave', 'timeout'], { engine: 'x' }, []],
      }),
    );
    const provider = new SearxngProvider('http://localhost:8888');
    await expect(provider.search('q')).rejects.toThrow(/mojeek; brave: timeout/);
  });
});
