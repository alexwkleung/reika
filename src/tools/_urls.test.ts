import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlanUrlNote,
  buildUrlGroundingNote,
  buildUrlGroundingNotice,
  extractUrls,
  groundUrls,
  groundUrlsForPlan,
} from './_urls.js';

describe('extractUrls', () => {
  it('finds http(s) URLs and dedupes', () => {
    const src = `fetch('https://api.example.com/v1'); // see http://example.com\nhttps://api.example.com/v1`;
    expect(extractUrls(src)).toEqual(['https://api.example.com/v1', 'http://example.com']);
  });

  it('trims trailing sentence punctuation', () => {
    expect(extractUrls('docs at https://example.com/page.')).toEqual(['https://example.com/page']);
    expect(extractUrls('(see https://example.com/x), ok')).toEqual(['https://example.com/x']);
  });

  it('ignores non-http schemes and bare prose', () => {
    expect(extractUrls('file:///etc/passwd and just some words')).toEqual([]);
    expect(extractUrls('ftp://example.com/file')).toEqual([]);
  });

  it('rejects a scheme with no host', () => {
    expect(extractUrls('https:// nothing here')).toEqual([]);
  });

  it('finds URLs embedded in script/link tags and attributes', () => {
    const html = '<script src="https://cdn.example.com/three.min.js"></script>';
    expect(extractUrls(html)).toEqual(['https://cdn.example.com/three.min.js']);
    expect(extractUrls("<link href='https://cdn.example.com/x.css'>")).toEqual([
      'https://cdn.example.com/x.css',
    ]);
  });

  it('skips a URL carrying a template-literal interpolation', () => {
    expect(extractUrls('const u = `https://api.example.com/${id}/items`;')).toEqual([]);
    // …but still grounds a literal URL sitting alongside it.
    expect(
      extractUrls('fetch(`https://api.example.com/${id}`); // base https://api.example.com/health'),
    ).toEqual(['https://api.example.com/health']);
  });
});

describe('buildUrlGroundingNote', () => {
  it('returns empty string for no results', () => {
    expect(buildUrlGroundingNote([])).toBe('');
  });

  it('marks a resolving URL with a collapsed snippet', () => {
    const note = buildUrlGroundingNote([
      { url: 'https://example.com', res: { ok: true, content: 'hello   world\n\nfoo', extractedChars: 18 } },
    ]);
    expect(note).toContain('✓ https://example.com — resolved: hello world foo…');
  });

  it('flags a non-resolving URL as an instruction to fix', () => {
    const note = buildUrlGroundingNote([
      { url: 'https://nope.example/x', res: { ok: false, reached: true, error: '404 Not Found' } },
    ]);
    expect(note).toContain('✗ https://nope.example/x — did NOT resolve (404 Not Found)');
    expect(note).toMatch(/do not assume it works/i);
  });
});

describe('buildUrlGroundingNotice', () => {
  it('returns undefined for an empty run', () => {
    expect(buildUrlGroundingNotice([])).toBeUndefined();
  });

  it('reports info + all-reachable when every URL resolved', () => {
    const notice = buildUrlGroundingNotice([
      { url: 'https://a.example', res: { ok: true, content: 'x', extractedChars: 1 } },
      { url: 'https://b.example', res: { ok: true, content: 'y', extractedChars: 1 } },
    ]);
    expect(notice).toEqual({ tone: 'info', content: 'Grounded 2 links — all reachable.' });
  });

  it('warns and names the unreachable URL(s)', () => {
    const notice = buildUrlGroundingNotice([
      { url: 'https://ok.example', res: { ok: true, content: 'x', extractedChars: 1 } },
      { url: 'https://bad.example/x', res: { ok: false, reached: true, error: '404 Not Found' } },
    ]);
    expect(notice?.tone).toBe('warn');
    expect(notice?.content).toBe(
      'Grounded 2 links — 1 unreachable: https://bad.example/x (404 Not Found).',
    );
  });

  it('does NOT warn when nothing reached a server (possibly offline) — info, not a false alarm', () => {
    const notice = buildUrlGroundingNotice([
      { url: 'https://a.example', res: { ok: false, reached: false, error: 'fetch failed' } },
    ]);
    expect(notice).toEqual({
      tone: 'info',
      content: "Grounded 1 link — couldn't verify 1 (no response; network may be down).",
    });
  });

  it('treats a no-response link as dead when the batch proves connectivity', () => {
    const notice = buildUrlGroundingNotice([
      { url: 'https://ok.example', res: { ok: true, content: 'x', extractedChars: 1 } },
      { url: 'https://invented.host', res: { ok: false, reached: false, error: 'ENOTFOUND' } },
    ]);
    expect(notice?.tone).toBe('warn');
    expect(notice?.content).toContain('https://invented.host (ENOTFOUND)');
  });
});

describe('groundUrls', () => {
  const original = process.env.REIKA_URL_GROUNDING;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REIKA_URL_GROUNDING;
    else process.env.REIKA_URL_GROUNDING = original;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockOk(html: string): Response {
    return { ok: true, status: 200, statusText: 'OK', text: async () => html } as unknown as Response;
  }

  it('is a strict no-op when the flag is off', async () => {
    delete process.env.REIKA_URL_GROUNDING;
    const out = await groundUrls({ cwd: '/tmp' }, 'see https://example.com');
    expect(out).toEqual({ note: undefined, notice: undefined });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns nothing when the text names no URL', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    const out = await groundUrls({ cwd: '/tmp' }, 'const x = 1;');
    expect(out).toEqual({ note: undefined, notice: undefined });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches an introduced URL and returns a model-facing note', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body><article>real content here</article></body></html>'),
    );
    const out = await groundUrls({ cwd: '/tmp' }, "fetch('https://api.example.com/v1')");
    expect(out.note).toContain('✓ https://api.example.com/v1 — resolved');
    expect(out.note).toContain('real content here');
  });

  it('marks URLs seen so a follow-up edit does not re-fetch', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk('<article>x</article>'));
    const groundedUrls = new Set<string>();
    await groundUrls({ cwd: '/tmp', groundedUrls }, 'https://example.com/a');
    const second = await groundUrls({ cwd: '/tmp', groundedUrls }, 'https://example.com/a');
    expect(second).toEqual({ note: undefined, notice: undefined });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns a user-facing receipt for the loop to place after the chip', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk('<article>x</article>'));
    const out = await groundUrls({ cwd: '/tmp' }, 'https://example.com/page');
    expect(out.notice).toEqual({ tone: 'info', content: 'Grounded 1 link — all reachable.' });
  });

  it('returns no receipt when grounding is a no-op (no URLs)', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    const out = await groundUrls({ cwd: '/tmp' }, 'const x = 1;');
    expect(out.notice).toBeUndefined();
  });

  it('caps the number of URLs fetched per call', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk('<article>x</article>'));
    const text = 'https://a.example https://b.example https://c.example';
    await groundUrls({ cwd: '/tmp' }, text);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe('buildPlanUrlNote', () => {
  it('returns empty when every URL resolved (no dead links to flag)', () => {
    expect(
      buildPlanUrlNote([
        { url: 'https://ok.example', res: { ok: true, content: 'x', extractedChars: 1 } },
      ]),
    ).toBe('');
  });

  it('lists only the unreachable URLs, backticked', () => {
    const note = buildPlanUrlNote([
      { url: 'https://ok.example', res: { ok: true, content: 'x', extractedChars: 1 } },
      { url: 'https://bad.example/x', res: { ok: false, reached: true, error: '404 Not Found' } },
    ]);
    expect(note).toContain('plan URL check');
    expect(note).toContain('`https://bad.example/x` (404 Not Found)');
    expect(note).not.toContain('ok.example');
  });

  it('does not flag a no-response link when nothing proves connectivity (offline-safe)', () => {
    expect(
      buildPlanUrlNote([
        { url: 'https://cdn.example.com/lib.js', res: { ok: false, reached: false, error: 'fetch failed' } },
      ]),
    ).toBe('');
  });
});

describe('groundUrlsForPlan', () => {
  const original = process.env.REIKA_URL_GROUNDING;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.REIKA_URL_GROUNDING;
    else process.env.REIKA_URL_GROUNDING = original;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockStatus(ok: boolean, status = 200): Response {
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Not Found',
      text: async () => '<article>doc</article>',
    } as unknown as Response;
  }

  it('is a strict no-op when the flag is off', async () => {
    delete process.env.REIKA_URL_GROUNDING;
    const out = await groundUrlsForPlan({ cwd: '/tmp' }, 'use https://cdn.example.com/lib.js');
    expect(out).toEqual({ note: undefined, notice: undefined });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns no plan note when the named URL resolves, but still returns the receipt', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus(true));
    const out = await groundUrlsForPlan({ cwd: '/tmp' }, 'load https://cdn.example.com/three.min.js');
    expect(out.note).toBeUndefined();
    expect(out.notice).toEqual({ tone: 'info', content: 'Grounded 1 link — all reachable.' });
  });

  it('flags a plan URL that does not resolve', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus(false, 404));
    const out = await groundUrlsForPlan({ cwd: '/tmp' }, 'load https://cdn.example.com/typo.js');
    expect(out.note).toContain('did not resolve');
    expect(out.note).toContain('`https://cdn.example.com/typo.js`');
    expect(out.notice?.tone).toBe('warn');
  });

  it('does not flag a plan URL when offline — info receipt, no false dead-link warning', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch failed'));
    const out = await groundUrlsForPlan({ cwd: '/tmp' }, 'load https://cdn.example.com/three.min.js');
    expect(out.note).toBeUndefined();
    expect(out.notice).toEqual(
      expect.objectContaining({ tone: 'info', content: expect.stringContaining("couldn't verify") }),
    );
  });
});
