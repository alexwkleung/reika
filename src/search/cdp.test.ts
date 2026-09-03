import { describe, expect, it, vi } from 'vitest';
import { CdpSearchProvider } from './cdp.js';
import { findChrome, type BrowserHost, type TabHandle } from './_chrome.js';

// The provider depends only on BrowserHost, so extraction and parsing are exercised without a
// browser on the machine running the suite — the page's answer is the thing under test.
function hostReturning(value: unknown, spy?: { navigated: string[]; closed: number }): BrowserHost {
  return {
    async newTab(): Promise<TabHandle> {
      return {
        async navigate(url: string) {
          spy?.navigated.push(url);
        },
        async evaluate() {
          if (value instanceof Error) throw value;
          return value;
        },
        async close() {
          if (spy) spy.closed++;
        },
      };
    },
  };
}

// `anchors` defaults high: a real SERP has dozens of links even when it matches nothing, and the
// provider reads a near-empty page as an interstitial rather than an answered search.
const page = (results: unknown[], blocked = false, anchors = 40) =>
  JSON.stringify({ results, blocked, anchors });

describe('CdpSearchProvider', () => {
  it('searches Brave, not Google — the engine that returns usable URLs', async () => {
    const spy = { navigated: [] as string[], closed: 0 };
    const provider = new CdpSearchProvider(hostReturning(page([]), spy));
    await provider.search('typescript satisfies operator');
    expect(spy.navigated[0]).toContain('search.brave.com/search?q=');
    expect(spy.navigated[0]).toContain('typescript%20satisfies%20operator');
  });

  it('normalizes results and marks the source', async () => {
    const provider = new CdpSearchProvider(
      hostReturning(
        page([
          { title: 'Docs', url: 'https://docs.libuv.org/en/v1.x/process.html', snippet: 'uv_kill' },
        ]),
      ),
    );
    await expect(provider.search('q')).resolves.toEqual([
      {
        title: 'Docs',
        url: 'https://docs.libuv.org/en/v1.x/process.html',
        snippet: 'uv_kill',
        source: 'brave',
      },
    ]);
  });

  it('drops results with no URL — the model can neither cite nor fetch them', async () => {
    const provider = new CdpSearchProvider(
      hostReturning(
        page([
          { title: 'A', url: '' },
          { title: 'B', url: 'https://b.example' },
        ]),
      ),
    );
    const out = await provider.search('q');
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://b.example');
  });

  it('caps at maxResults', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x/${i}` }));
    const provider = new CdpSearchProvider(hostReturning(page(many)));
    await expect(provider.search('q', { maxResults: 5 })).resolves.toHaveLength(5);
  });

  // #236's principle applied to this provider: a refused search must not read as an empty one, or
  // the model concludes its query was bad and rewords against a wall that refuses every variant.
  it('raises on a bot check rather than reporting an empty result set', async () => {
    const provider = new CdpSearchProvider(hostReturning(page([], true)));
    await expect(provider.search('q')).rejects.toThrow(/bot check/);
  });

  it('raises when the page ran no script at all', async () => {
    const provider = new CdpSearchProvider(hostReturning(undefined));
    await expect(provider.search('q')).rejects.toThrow(/returned nothing/);
  });

  it('raises on unparseable output instead of silently returning nothing', async () => {
    const provider = new CdpSearchProvider(hostReturning('<!doctype html>'));
    await expect(provider.search('q')).rejects.toThrow(/could not parse/);
  });

  it('reports a genuine zero-result search as empty, not as a failure', async () => {
    const provider = new CdpSearchProvider(hostReturning(page([])));
    await expect(provider.search('q')).resolves.toEqual([]);
  });

  // The phrase list cannot be complete — the challenge that prompted this check reads "Verifying
  // you're not a bot", which none of the obvious phrasings would have matched. So the page's shape
  // has to carry the verdict too: a SERP with almost no links is an interstitial, not a miss.
  it('raises on a near-empty page even when no known challenge phrase appears', async () => {
    const provider = new CdpSearchProvider(hostReturning(page([], false, 3)));
    await expect(provider.search('q')).rejects.toThrow(/no result list \(3 links/);
  });

  it('matches the wording Brave actually serves', async () => {
    const body = JSON.stringify({
      results: [],
      anchors: 3,
      blocked: true,
    });
    const provider = new CdpSearchProvider(hostReturning(body));
    await expect(provider.search('q')).rejects.toThrow(/bot check/);
  });

  it('closes the tab even when the search fails', async () => {
    const spy = { navigated: [] as string[], closed: 0 };
    const provider = new CdpSearchProvider(hostReturning(page([], true), spy));
    await expect(provider.search('q')).rejects.toThrow();
    expect(spy.closed).toBe(1);
  });
});

describe('findChrome', () => {
  it('prefers REIKA_CHROME_PATH over the well-known locations', () => {
    expect(findChrome({ REIKA_CHROME_PATH: '/opt/my-chrome' } as NodeJS.ProcessEnv)).toBe(
      '/opt/my-chrome',
    );
  });

  it('ignores a blank override rather than trying to exec whitespace', () => {
    expect(findChrome({ REIKA_CHROME_PATH: '   ' } as NodeJS.ProcessEnv)).not.toBe('   ');
  });
});
