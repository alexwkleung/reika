import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, fetchUrlTool } from './fetch.js';
import { resetSpillDir } from './_spill.js';
import { parseSavedPage, resetSavedPages } from './fetch.js';
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
    expect(result).toEqual({ ok: false, reached: true, error: '404 Not Found' });
  });

  it('returns {ok:false} with the error message on a network failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await extractUrl('https://unreachable.example');
    expect(result).toEqual({ ok: false, reached: false, error: 'ECONNREFUSED' });
  });
});

function mockRedirect(status: number, location: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Redirect',
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  } as unknown as Response;
}

// The host policy (#164). extractUrl is the choke point every egress path funnels through, so this
// is where "the agent must not reach the local model server or a metadata endpoint" is enforced.
describe('extractUrl — host policy', () => {
  it('blocks a loopback URL without making a request', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const result = await extractUrl('http://127.0.0.1:11434/api/tags');
    expect(result).toEqual({
      ok: false,
      reached: false,
      error: expect.stringContaining('blocked by host policy'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks the cloud metadata endpoint', async () => {
    const result = await extractUrl('http://169.254.169.254/latest/meta-data/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/link-local/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports blocked as not-reached, so a grounder does not read it as an offline network', async () => {
    const result = await extractUrl('http://localhost/');
    // reached:false is the honest value (no request went out), and the error text carries the
    // distinction that `reached` alone cannot.
    expect(result).toMatchObject({ ok: false, reached: false });
  });

  it('allows an ordinary public URL through', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body><article>public</article></body></html>'),
    );
    const result = await extractUrl('https://example.com');
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a private address when the caller opts in (pasted-URL path)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body><article>dev server</article></body></html>'),
    );
    const result = await extractUrl('http://localhost:3000/', { allowPrivate: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain('dev server');
  });
});

// A check on the URL as written is decorative on its own: one 302 walks around it. The chain is
// walked here so the policy sees every hop.
describe('extractUrl — redirect chain', () => {
  it('follows an ordinary redirect and extracts the final page', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockRedirect(301, 'https://example.com/final'))
      .mockResolvedValueOnce(mockOk('<html><body><article>arrived</article></body></html>'));
    const result = await extractUrl('http://example.com/start');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain('arrived');
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/final');
  });

  it('resolves a relative Location against the current URL', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockRedirect(302, '/moved'))
      .mockResolvedValueOnce(mockOk('<html><body><article>ok</article></body></html>'));
    await extractUrl('https://example.com/a/b');
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/moved');
  });

  it('BLOCKS a public URL that redirects into loopback', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockRedirect(302, 'http://127.0.0.1:11434/api/tags'));
    const result = await extractUrl('https://evil.example/bounce');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/blocked by host policy/);
      expect(result.error).toMatch(/redirected to/);
    }
    // The first request went out (it was a public address); the second never did.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a redirect into cloud metadata', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockRedirect(307, 'http://169.254.169.254/latest/meta-data/'));
    const result = await extractUrl('https://example.com/x');
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect into a private address when the caller opted in', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockRedirect(302, 'http://localhost:3000/app'))
      .mockResolvedValueOnce(mockOk('<html><body><article>dev</article></body></html>'));
    const result = await extractUrl('https://example.com/go', { allowPrivate: true });
    expect(result.ok).toBe(true);
  });

  it('follows a chain longer than a handful, matching the pre-existing limit', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 12; i++) {
      fetchMock.mockResolvedValueOnce(mockRedirect(302, `https://example.com/hop${i}`));
    }
    fetchMock.mockResolvedValueOnce(
      mockOk('<html><body><article>end of chain</article></body></html>'),
    );
    const result = await extractUrl('https://example.com/start');
    // 12 hops used to resolve under redirect:'follow' (limit 20). A tighter cap here would be a
    // silent regression for any site with a long canonicalization chain.
    expect(result.ok).toBe(true);
  });

  it('gives up after the hop cap instead of looping forever', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(mockRedirect(302, 'https://example.com/loop'));
    const result = await extractUrl('https://example.com/loop');
    expect(result).toEqual({
      ok: false,
      reached: true,
      error: expect.stringContaining('too many redirects'),
    });
    // Bounded, and bounded at the SAME place redirect:'follow' bounded it before the manual walk
    // replaced it — 20 hops, then one more attempt that trips the cap.
    expect(fetchMock.mock.calls.length).toBe(21);
  });

  it('drains each redirect body instead of leaking the connection', async () => {
    // `follow` released these internally; the manual walk has to. An unread body holds its
    // connection out of undici's pool until GC and throws nothing, so only a test catches it.
    const cancels: number[] = [];
    const withBody = (n: number, location: string) => ({
      ...mockRedirect(302, location),
      body: { cancel: async () => void cancels.push(n) },
    });
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(withBody(1, 'https://example.com/b') as unknown as Response)
      .mockResolvedValueOnce(withBody(2, 'https://example.com/c') as unknown as Response)
      .mockResolvedValueOnce(mockOk('<html><body><article>end</article></body></html>'));
    const result = await extractUrl('https://example.com/a');
    expect(result.ok).toBe(true);
    expect(cancels).toEqual([1, 2]);
  });

  it('still follows the chain when a hop exposes no body', async () => {
    // Node can hand back a bodyless response (204/HEAD-ish). The optional chain must not throw.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockRedirect(301, 'https://example.com/final'))
      .mockResolvedValueOnce(mockOk('<html><body><article>arrived</article></body></html>'));
    const result = await extractUrl('https://example.com/start');
    expect(result.ok).toBe(true);
  });

  it('treats a 3xx with no Location as a plain error response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: { get: () => null },
      text: async () => '',
    } as unknown as Response);
    const result = await extractUrl('https://example.com/x');
    expect(result).toEqual({ ok: false, reached: true, error: '302 Found' });
  });
});

describe('fetch_url tool — host policy', () => {
  it('refuses a loopback URL with a reason the model can act on', async () => {
    const result = await fetchUrlTool.run(
      { url: 'http://127.0.0.1:11434/api/tags' },
      { cwd: '/tmp' },
    );
    expect(result.summary).toMatch(/blocked by host policy/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('charges the blocked attempt against the turn budget', async () => {
    // Deliberate: a refusal that costs nothing lets a spiraling model probe private addresses
    // without bound. Charging it drains the turn's fetch budget and pushes the model onward.
    const budget = makeBudget();
    await fetchUrlTool.run({ url: 'http://192.168.1.1/' }, { cwd: '/tmp', webBudget: budget });
    expect(budget.fetches.used).toBe(1);
  });

  it('does not record a blocked URL as a source', async () => {
    const fetchedUrls = new Set<string>();
    await fetchUrlTool.run({ url: 'http://localhost/' }, { cwd: '/tmp', fetchedUrls });
    expect(fetchedUrls.size).toBe(0);
  });
});

// The fetch half of #139. Two cuts can shorten a fetched page — the tool's own 64KB cap, and the
// context window at serialization — and the spill file is the answer to both: the marker at
// either cut tells the model to read a narrower range, which for fetch_url is only possible when
// the page is a local file.
describe('fetch_url tool — spill (#139)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    resetSpillDir();
    resetSavedPages();
    process.env.REIKA_SPILL = '1';
  });

  afterEach(async () => {
    delete process.env.REIKA_SPILL;
    resetSpillDir();
    resetSavedPages();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const article = (chars: number): string =>
    `<html><body><article><p>${'word '.repeat(Math.ceil(chars / 5))}</p></article></body></html>`;

  const locatorOf = (summary: string): string => {
    const m = /saved to (\S+)\)/.exec(summary);
    expect(m, summary).not.toBeNull();
    dirs.push(dirname(m![1]));
    return m![1];
  };

  it('saves a page under the tool cap when it is big enough for the window to chop', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk(article(10_000)));
    const result = await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' });
    const path = locatorOf(result.summary);
    // The summary carries the locator: it is the only part of the result that survives a
    // fully-starved window, and the part the model sees when it comes back to the URL later.
    expect(result.summary).toMatch(/^Fetched https:\/\/example\.com\/doc \(\d+ chars extracted; /);
    // The payload is the whole page (no tool-cap cut) plus the footer.
    expect(result.payload).toContain('word word');
    expect(result.payload).toContain(`(Full page saved to ${path}`);
    expect(result.payload).toContain('instead of fetching the URL again');
    expect(result.payload).not.toContain('Showing');
    // The file is the page, byte for byte.
    const saved = await readFile(path, 'utf8');
    expect(result.payload!.startsWith(saved)).toBe(true);
    expect(saved.length).toBeGreaterThan(9_000);
  });

  it('saves the whole page and pages the head when the tool cap cuts it', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk(article(100_000)));
    const result = await fetchUrlTool.run({ url: 'https://example.com/long' }, { cwd: '/tmp' });
    const path = locatorOf(result.summary);
    expect(result.summary).toMatch(/\(\d{5,} chars extracted; full page saved to /);
    expect(result.payload).toContain(`(Showing 65536 of `);
    expect(result.payload).toContain(`Full page saved to ${path}`);
    expect(result.payload).toContain('Do not re-run this fetch');
    // The old "…(truncated, N more chars)" tail is gone — the footer replaces it.
    expect(result.payload).not.toContain('…(truncated');
    const saved = await readFile(path, 'utf8');
    expect(saved.length).toBeGreaterThan(65_536);
    expect(result.payload!.startsWith(saved.slice(0, 65_536))).toBe(true);
  });

  it('leaves a small page byte-identical: nothing for the window to chop, nothing to save', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk(article(500)));
    const result = await fetchUrlTool.run({ url: 'https://example.com/small' }, { cwd: '/tmp' });
    expect(result.summary).toMatch(
      /^Fetched https:\/\/example\.com\/small \(\d+ chars extracted\)$/,
    );
    expect(result.payload).not.toContain('saved to');
  });

  it('is a strict no-op with REIKA_SPILL=0: the pre-spill result, truncation tail and all', async () => {
    process.env.REIKA_SPILL = '0';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk(article(100_000)));
    const result = await fetchUrlTool.run({ url: 'https://example.com/long' }, { cwd: '/tmp' });
    expect(result.summary).toMatch(
      /^Fetched https:\/\/example\.com\/long \(\d+ chars extracted\)$/,
    );
    expect(result.payload).toMatch(/…\(truncated, \d+ more chars\)$/);
    expect(result.payload).not.toContain('saved to');
  });

  it('keeps the tool cap for harness callers: extractUrl still truncates by default', async () => {
    // The grounders and pasted-URL expansion must never spill — a grounding check would write a
    // file whose locator nobody sees. They get the capped contract they always had, and only the
    // tool asks for the page uncut.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk(article(100_000)));
    const capped = await extractUrl('https://example.com/long');
    expect(capped.ok && capped.content.length).toBeLessThan(66_000);
    expect(capped.ok && capped.content).toMatch(/…\(truncated, \d+ more chars\)$/);
    const uncut = await extractUrl('https://example.com/long', { untruncated: true });
    expect(uncut.ok && uncut.content.length).toBeGreaterThan(99_000);
    expect(uncut.ok && uncut.content).not.toContain('…(truncated');
  });

  // #296: the same URL fetched again is served from the saved copy — no request, no budget.
  describe('repeat fetch of a saved page (#296)', () => {
    it('serves the second fetch from the file without a network request or budget use', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(mockOk(article(10_000)));
      const budget = makeBudget(1);
      const fetchedUrls = new Set<string>();
      const first = await fetchUrlTool.run(
        { url: 'https://example.com/doc' },
        { cwd: '/tmp', webBudget: budget, fetchedUrls },
      );
      const path = locatorOf(first.summary);
      expect(budget.fetches.used).toBe(1);
      // Budget is now exhausted — a real fetch would be refused. The repeat is not one.
      const second = await fetchUrlTool.run(
        { url: 'https://example.com/doc' },
        { cwd: '/tmp', webBudget: budget, fetchedUrls },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(budget.fetches.used).toBe(1);
      expect(second.summary).toContain('already fetched this session, served from the saved copy');
      expect(second.summary).toContain(`full page saved to ${path}`);
      // Same page, same footer: the model gets what a re-fetch would have returned.
      expect(second.payload).toBe(first.payload);
      expect(fetchedUrls.has('https://example.com/doc')).toBe(true);
      // Both summaries parse to the one locator the recap will list.
      expect(parseSavedPage(first.summary)).toEqual({ url: 'https://example.com/doc', path });
      expect(parseSavedPage(second.summary)).toEqual({ url: 'https://example.com/doc', path });
    });

    it('falls through to a real fetch when the saved file is gone', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(mockOk(article(10_000)));
      const first = await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' });
      const path = locatorOf(first.summary);
      await rm(path);
      const second = await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(second.summary).not.toContain('served from the saved copy');
      expect(locatorOf(second.summary)).not.toBe(path);
    });

    it('does not cache a page too small to have been saved, or anything under REIKA_SPILL=0', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(mockOk(article(500)));
      await fetchUrlTool.run({ url: 'https://example.com/small' }, { cwd: '/tmp' });
      await fetchUrlTool.run({ url: 'https://example.com/small' }, { cwd: '/tmp' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockResolvedValue(mockOk(article(10_000)));
      await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' });
      locatorOf(
        (await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' })).summary,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      process.env.REIKA_SPILL = '0';
      await fetchUrlTool.run({ url: 'https://example.com/doc' }, { cwd: '/tmp' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('parseSavedPage rejects failed fetches and unsaved pages', () => {
      expect(parseSavedPage('Fetch failed: https://x (404 Not Found)')).toBeNull();
      expect(parseSavedPage('Fetched https://x (900 chars extracted)')).toBeNull();
    });
  });
});
