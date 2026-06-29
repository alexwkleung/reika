import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, fetchUrlTool } from './fetch.js';
import type { WebBudget } from '../types.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockOk(html: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => html,
  } as unknown as Response;
}

function makeBudget(fetchesMax = 5): WebBudget {
  return {
    searches: { used: 0, max: 3 },
    fetches: { used: 0, max: fetchesMax },
  };
}

describe('fetch_url tool — budget enforcement', () => {
  it('increments fetch budget on each call', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body>hi</body></html>'),
    );
    const budget = makeBudget();
    await fetchUrlTool.run({ url: 'https://example.com' }, { cwd: '/tmp', webBudget: budget });
    expect(budget.fetches.used).toBe(1);
  });

  it('blocks fetch when budget is exhausted', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const budget = makeBudget(2);
    budget.fetches.used = 2;
    const result = await fetchUrlTool.run(
      { url: 'https://example.com' },
      { cwd: '/tmp', webBudget: budget },
    );
    expect(result.summary).toMatch(/Fetch budget exceeded/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(budget.fetches.used).toBe(2);
  });

  it('rejects empty URL before consuming budget', async () => {
    const budget = makeBudget();
    const result = await fetchUrlTool.run({ url: '' }, { cwd: '/tmp', webBudget: budget });
    expect(result.summary).toMatch(/empty URL/);
    expect(budget.fetches.used).toBe(0);
  });

  it('rejects non-http URL before consuming budget', async () => {
    const budget = makeBudget();
    const result = await fetchUrlTool.run(
      { url: 'file:///etc/passwd' },
      { cwd: '/tmp', webBudget: budget },
    );
    expect(result.summary).toMatch(/not an http\(s\) URL/);
    expect(budget.fetches.used).toBe(0);
  });

  it('records URL in ctx.fetchedUrls on successful fetch', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body>hi</body></html>'),
    );
    const fetchedUrls = new Set<string>();
    await fetchUrlTool.run({ url: 'https://example.com/page' }, { cwd: '/tmp', fetchedUrls });
    expect(fetchedUrls.has('https://example.com/page')).toBe(true);
  });

  it('does NOT record URL on a failed fetch (non-OK status)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    } as unknown as Response);
    const fetchedUrls = new Set<string>();
    await fetchUrlTool.run({ url: 'https://example.com/missing' }, { cwd: '/tmp', fetchedUrls });
    expect(fetchedUrls.size).toBe(0);
  });

  it('does NOT record URL on a network error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const fetchedUrls = new Set<string>();
    await fetchUrlTool.run({ url: 'https://unreachable.example' }, { cwd: '/tmp', fetchedUrls });
    expect(fetchedUrls.size).toBe(0);
  });

  it('dedupes when same URL is fetched twice', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body>hi</body></html>'),
    );
    const fetchedUrls = new Set<string>();
    await fetchUrlTool.run({ url: 'https://example.com' }, { cwd: '/tmp', fetchedUrls });
    await fetchUrlTool.run({ url: 'https://example.com' }, { cwd: '/tmp', fetchedUrls });
    expect(fetchedUrls.size).toBe(1);
  });
});

// Direct coverage of the shared extraction helper the fetch_url tool wraps and harness-driven
// URL grounders (phase 1b) call without going through the tool — no budget/validation here, just
// the network + extraction contract.
describe('extractUrl — harness-callable extraction', () => {
  it('returns ok with content and pre-truncation char count', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body><article>hello world</article></body></html>'),
    );
    const result = await extractUrl('https://example.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('hello world');
      expect(result.extractedChars).toBe(result.content.length);
    }
  });

  it('returns {ok:false} with status text on a non-OK response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    } as unknown as Response);
    const result = await extractUrl('https://example.com/missing');
    expect(result).toEqual({ ok: false, error: '404 Not Found' });
  });

  it('returns {ok:false} with the error message on a network failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await extractUrl('https://unreachable.example');
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});
