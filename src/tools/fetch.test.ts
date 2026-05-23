import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchUrlTool } from './fetch.js';
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
});
