import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractOptions, UrlExtraction } from '../tools/fetch.js';

const extractUrl = vi.hoisted(() =>
  vi.fn<(url: string, opts?: ExtractOptions) => Promise<UrlExtraction>>(),
);
vi.mock('../tools/fetch.js', () => ({ extractUrl }));

const { expandPastedUrls } = await import('./pastedurls.js');

function ok(content: string): UrlExtraction {
  return { ok: true, content, extractedChars: content.length };
}

beforeEach(() => {
  extractUrl.mockReset();
  extractUrl.mockImplementation(async (url: string) => ok(`content of ${url}`));
});

describe('expandPastedUrls', () => {
  it('is a strict no-op when disabled', async () => {
    const r = await expandPastedUrls('see https://example.com/docs', { enabled: false });
    expect(r.blocks).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(extractUrl).not.toHaveBeenCalled();
  });

  it('does nothing when the prompt has no URL', async () => {
    const r = await expandPastedUrls('fix the parser', { enabled: true });
    expect(r.blocks).toEqual([]);
    expect(extractUrl).not.toHaveBeenCalled();
  });

  it('fetches a pasted URL into a labeled block', async () => {
    const r = await expandPastedUrls('read https://example.com/docs and summarize', {
      enabled: true,
    });
    expect(r.fetched).toEqual(['https://example.com/docs']);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toContain('<url href="https://example.com/docs">');
    expect(r.blocks[0]).toContain('content of https://example.com/docs');
    expect(r.notices[0]).toMatchObject({ tone: 'info' });
  });

  it('caps at two URLs and says so', async () => {
    const input = 'https://a.com https://b.com https://c.com';
    const r = await expandPastedUrls(input, { enabled: true });
    expect(extractUrl).toHaveBeenCalledTimes(2);
    expect(r.fetched).toEqual(['https://a.com', 'https://b.com']);
    expect(r.notices.some(n => n.text.includes('3 found'))).toBe(true);
  });

  it('reports the fetch count before the requests go out', async () => {
    const onStart = vi.fn();
    let startedBeforeFetch = false;
    extractUrl.mockImplementation(async () => {
      startedBeforeFetch = onStart.mock.calls.length === 1;
      return ok('x');
    });
    await expandPastedUrls('https://a.com and https://b.com', { enabled: true, onStart });
    expect(onStart).toHaveBeenCalledExactlyOnceWith(2);
    expect(startedBeforeFetch).toBe(true);
  });

  it('does not report a start when there is nothing to fetch', async () => {
    const onStart = vi.fn();
    await expandPastedUrls('no links here', { enabled: true, onStart });
    await expandPastedUrls('https://a.com', { enabled: false, onStart });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('truncates a long page and points at fetch_url for the rest', async () => {
    extractUrl.mockResolvedValue(ok('y'.repeat(20_000)));
    const r = await expandPastedUrls('https://example.com', { enabled: true });
    expect(r.blocks[0].length).toBeLessThan(9000);
    expect(r.blocks[0]).toContain('call fetch_url for the full page');
  });

  it('warns without a block when the server returns an error', async () => {
    extractUrl.mockResolvedValue({ ok: false, reached: true, error: '404 Not Found' });
    const r = await expandPastedUrls('https://example.com/gone', { enabled: true });
    expect(r.blocks).toEqual([]);
    expect(r.fetched).toEqual([]);
    expect(r.notices[0]).toMatchObject({ tone: 'warn' });
    expect(r.notices[0].text).toContain("Couldn't fetch");
  });

  it('distinguishes an unreachable host from a dead link', async () => {
    extractUrl.mockResolvedValue({ ok: false, reached: false, error: 'getaddrinfo ENOTFOUND' });
    const r = await expandPastedUrls('https://example.com', { enabled: true });
    expect(r.notices[0].text).toContain("Couldn't reach");
  });

  it('keeps a good fetch when the other one fails', async () => {
    extractUrl.mockImplementation(async (url: string) =>
      url.includes('bad') ? { ok: false, reached: true, error: '500' } : ok('good page'),
    );
    const r = await expandPastedUrls('https://bad.com and https://good.com', { enabled: true });
    expect(r.fetched).toEqual(['https://good.com']);
    expect(r.blocks).toHaveLength(1);
    expect(r.notices).toHaveLength(2);
  });
});

// #164: the host policy stops the MODEL and the HARNESS from reaching loopback/LAN addresses off
// attacker-influenced text. A URL the user pasted is neither — it is a request — so this path opts
// out, and "read my dev server at http://localhost:3000" keeps working.
describe('expandPastedUrls — host policy exemption', () => {
  it('opts out of the private-host block, because the user typed the address', async () => {
    await expandPastedUrls('why is http://localhost:3000/api 500ing?', { enabled: true });
    expect(extractUrl).toHaveBeenCalledWith('http://localhost:3000/api', { allowPrivate: true });
  });

  it('passes the same opt-out for a public URL, so provenance is the rule, not the address', async () => {
    await expandPastedUrls('read https://example.com/docs', { enabled: true });
    expect(extractUrl).toHaveBeenCalledWith('https://example.com/docs', { allowPrivate: true });
  });
});
