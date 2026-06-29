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
      { url: 'https://nope.example/x', res: { ok: false, error: '404 Not Found' } },
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
      { url: 'https://bad.example/x', res: { ok: false, error: '404 Not Found' } },
    ]);
    expect(notice?.tone).toBe('warn');
    expect(notice?.content).toBe(
      'Grounded 2 links — 1 unreachable: https://bad.example/x (404 Not Found).',
    );
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
    expect(out).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns undefined when the text names no URL', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    const out = await groundUrls({ cwd: '/tmp' }, 'const x = 1;');
    expect(out).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches an introduced URL and returns a grounding note', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOk('<html><body><article>real content here</article></body></html>'),
    );
    const out = await groundUrls({ cwd: '/tmp' }, "fetch('https://api.example.com/v1')");
    expect(out).toContain('✓ https://api.example.com/v1 — resolved');
    expect(out).toContain('real content here');
  });

  it('marks URLs seen so a follow-up edit does not re-fetch', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk('<article>x</article>'));
    const groundedUrls = new Set<string>();
    await groundUrls({ cwd: '/tmp', groundedUrls }, 'https://example.com/a');
    const second = await groundUrls({ cwd: '/tmp', groundedUrls }, 'https://example.com/a');
    expect(second).toBeUndefined();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('emits a user-visible onNotice when grounding runs', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockOk('<article>x</article>'));
    const onNotice = vi.fn();
    await groundUrls({ cwd: '/tmp', onNotice }, 'https://example.com/page');
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith({ tone: 'info', content: 'Grounded 1 link — all reachable.' });
  });

  it('does not emit onNotice when grounding is a no-op (no URLs)', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    const onNotice = vi.fn();
    await groundUrls({ cwd: '/tmp', onNotice }, 'const x = 1;');
    expect(onNotice).not.toHaveBeenCalled();
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
      { url: 'https://bad.example/x', res: { ok: false, error: '404 Not Found' } },
    ]);
    expect(note).toContain('plan URL check');
    expect(note).toContain('`https://bad.example/x` (404 Not Found)');
    expect(note).not.toContain('ok.example');
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
    expect(out).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns no plan note when the named URL resolves, but still emits the receipt', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus(true));
    const onNotice = vi.fn();
    const out = await groundUrlsForPlan(
      { cwd: '/tmp', onNotice },
      'load https://cdn.example.com/three.min.js',
    );
    expect(out).toBeUndefined();
    expect(onNotice).toHaveBeenCalledWith({ tone: 'info', content: 'Grounded 1 link — all reachable.' });
  });

  it('flags a plan URL that does not resolve', async () => {
    process.env.REIKA_URL_GROUNDING = '1';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus(false, 404));
    const onNotice = vi.fn();
    const out = await groundUrlsForPlan(
      { cwd: '/tmp', onNotice },
      'load https://cdn.example.com/typo.js',
    );
    expect(out).toContain('did not resolve');
    expect(out).toContain('`https://cdn.example.com/typo.js`');
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'warn' }),
    );
  });
});
