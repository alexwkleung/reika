import { describe, expect, it } from 'vitest';
import { CdpSearchProvider } from './cdp.js';
import { findChrome, type BrowserHost, type TabHandle } from './_chrome.js';
import { SearchUnavailableError } from './types.js';

type Spy = { navigated: string[]; closed: number; shown: number; hidden: number };
const spy = (): Spy => ({ navigated: [], closed: 0, shown: 0, hidden: 0 });

// The provider depends only on BrowserHost, so extraction and parsing are exercised without a
// browser on the machine running the suite — the page's answer is the thing under test. A list
// of values plays a page that changes under polling (a challenge the user then solves); the last
// value repeats once the list is spent.
function hostReturning(value: unknown | unknown[], s?: Spy): BrowserHost {
  const pages = Array.isArray(value) ? [...value] : [value];
  return {
    async newTab(): Promise<TabHandle> {
      return {
        async navigate(url: string) {
          s?.navigated.push(url);
        },
        async evaluate() {
          const v = pages.length > 1 ? pages.shift() : pages[0];
          if (v instanceof Error) throw v;
          return v;
        },
        async show() {
          if (s) s.shown++;
        },
        async hide() {
          if (s) s.hidden++;
        },
        async close() {
          if (s) s.closed++;
        },
      };
    },
  };
}

// No pacing in the suite: probes run back to back, and the wait is long enough that a scripted
// page always gets to its last state. Timeout tests pass their own zero wait.
const fast = { challengeWaitMs: 5_000, challengePollMs: 0 };
const cdp = (host: BrowserHost) => new CdpSearchProvider(host, fast);
// A check nobody clears: the raise happens, the wait expires at once.
const unsolved = (host: BrowserHost) =>
  new CdpSearchProvider(host, { challengeWaitMs: 0, challengePollMs: 0 });

// `anchors` defaults high: a real SERP has dozens of links even when it matches nothing, and the
// provider reads a near-empty page as an interstitial rather than an answered search.
const page = (results: unknown[], blocked = false, anchors = 40) =>
  JSON.stringify({ results, blocked, anchors });

describe('CdpSearchProvider', () => {
  it('searches Brave, not Google — the engine that returns usable URLs', async () => {
    const s = spy();
    const provider = cdp(hostReturning(page([]), s));
    await provider.search('typescript satisfies operator');
    expect(s.navigated[0]).toContain('search.brave.com/search?q=');
    expect(s.navigated[0]).toContain('typescript%20satisfies%20operator');
  });

  it('normalizes results and marks the source', async () => {
    const provider = cdp(
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
    const provider = cdp(
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
    const provider = cdp(hostReturning(page(many)));
    await expect(provider.search('q', { maxResults: 5 })).resolves.toHaveLength(5);
  });

  // #236's principle applied to this provider: a refused search must not read as an empty one, or
  // the model concludes its query was bad and rewords against a wall that refuses every variant.
  it('raises on an uncleared bot check rather than reporting an empty result set', async () => {
    const provider = unsolved(hostReturning(page([], true)));
    await expect(provider.search('q')).rejects.toThrow(/bot check/);
  });

  it('raises the typed provider-level failure on a bot check, so the turn latches', async () => {
    const provider = unsolved(hostReturning(page([], true)));
    const err = await provider.search('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect((err as SearchUnavailableError).remedy).toMatch(/complete the check once/);
    expect((err as SearchUnavailableError).remedy).toMatch(/window is open/);
  });

  // A page that ran no script is not the provider being unavailable — the next query may load fine,
  // so this must stay an ordinary error or one bad page would mute search for the whole turn.
  it('keeps a page-level failure query-level, not provider-level', async () => {
    const provider = cdp(hostReturning('<!doctype html>'));
    const err = await provider.search('q').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SearchUnavailableError);
  });

  it('raises when the page ran no script at all', async () => {
    const provider = cdp(hostReturning(undefined));
    await expect(provider.search('q')).rejects.toThrow(/returned nothing/);
  });

  it('raises on unparseable output instead of silently returning nothing', async () => {
    const provider = cdp(hostReturning('<!doctype html>'));
    await expect(provider.search('q')).rejects.toThrow(/could not parse/);
  });

  it('reports a genuine zero-result search as empty, not as a failure', async () => {
    const provider = cdp(hostReturning(page([])));
    await expect(provider.search('q')).resolves.toEqual([]);
  });

  // The phrase list cannot be complete — the challenge that prompted this check reads "Verifying
  // you're not a bot", which none of the obvious phrasings would have matched. So the page's shape
  // has to carry the verdict too: a SERP with almost no links is an interstitial, not a miss.
  it('raises on a near-empty page even when no known challenge phrase appears', async () => {
    const provider = unsolved(hostReturning(page([], false, 3)));
    await expect(provider.search('q')).rejects.toThrow(/no result list \(3 links/);
  });

  it('matches the wording Brave actually serves', async () => {
    const body = JSON.stringify({
      results: [],
      anchors: 3,
      blocked: true,
    });
    const provider = unsolved(hostReturning(body));
    await expect(provider.search('q')).rejects.toThrow(/bot check/);
  });

  it('closes the tab when the search fails for a reason a human cannot clear', async () => {
    const s = spy();
    const provider = cdp(hostReturning('<!doctype html>', s));
    await expect(provider.search('q')).rejects.toThrow();
    expect(s.closed).toBe(1);
  });

  // #238: a bot check is a gate only a human can open, and the solve sticks on the profile. So the
  // provider surfaces the window, waits for the page to turn into a SERP, and carries on — the
  // search that hit the check is the one that answers, and no budget is spent on a retry.
  describe('bot check recovery', () => {
    const solved = [{ title: 'Docs', url: 'https://docs.example/a', snippet: 'x' }];

    it('raises the window, waits for the check to clear, and answers the same search', async () => {
      const s = spy();
      const states: string[] = [];
      const provider = cdp(
        hostReturning([page([], true), page([], true), page(solved), page(solved)], s),
      );
      const out = await provider.search('q', { onChallenge: st => states.push(st) });
      expect(out.map(r => r.url)).toEqual(['https://docs.example/a']);
      expect(s.shown).toBe(1);
      expect(states).toEqual(['raised', 'cleared']);
    });

    it('puts the window back down once the check has cleared', async () => {
      const s = spy();
      const provider = cdp(hostReturning([page([], true), page(solved)], s));
      await provider.search('q');
      expect(s.hidden).toBe(1);
      expect(s.closed).toBe(1);
    });

    it('keeps polling through a probe that fails mid-navigation', async () => {
      const s = spy();
      const provider = cdp(
        hostReturning([page([], true), undefined, '<!doctype html>', page(solved)], s),
      );
      await expect(provider.search('q')).resolves.toHaveLength(1);
      expect(s.shown).toBe(1);
    });

    it('treats a near-empty page as a check to raise, not a wall to report', async () => {
      const s = spy();
      const provider = cdp(hostReturning([page([], false, 3), page(solved)], s));
      await expect(provider.search('q')).resolves.toHaveLength(1);
      expect(s.shown).toBe(1);
    });

    it('fails the turn when nobody clears the check, and leaves the raised tab open', async () => {
      const s = spy();
      const states: string[] = [];
      const provider = unsolved(hostReturning(page([], true), s));
      const err = await provider
        .search('q', { onChallenge: st => states.push(st) })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SearchUnavailableError);
      expect(states).toEqual(['raised']);
      // The check is still on that tab; closing it would take it away from the user who was just
      // told to complete it, and minimizing would hide it from them.
      expect(s.closed).toBe(0);
      expect(s.hidden).toBe(0);
    });

    it('reports a wall that survives the solve as a failure, not a second challenge', async () => {
      const s = spy();
      // Challenged, solved (the probe sees a SERP), then the reload lands on something with no
      // result list at all.
      const provider = cdp(hostReturning([page([], true), page(solved), page([], false, 2)], s));
      await expect(provider.search('q')).rejects.toThrow(/no result list \(2 links/);
      expect(s.shown).toBe(1);
      expect(s.closed).toBe(1);
    });

    // Parallel searches in a turn are refused together and the solve is profile-wide: one raised
    // window is what the user should get, and the other search should ride the same solve.
    it('shares one solve across concurrent searches instead of raising twice', async () => {
      const s = spy();
      let solvedAt = 0;
      const host: BrowserHost = {
        async newTab(): Promise<TabHandle> {
          let probes = 0;
          return {
            async navigate(url: string) {
              s.navigated.push(url);
            },
            async evaluate() {
              probes++;
              return solvedAt > 0 && probes > 1 ? page(solved) : page([], true);
            },
            async show() {
              s.shown++;
              solvedAt = Date.now();
            },
            async hide() {
              s.hidden++;
            },
            async close() {
              s.closed++;
            },
          };
        },
      };
      const provider = cdp(host);
      const [a, b] = await Promise.all([provider.search('a'), provider.search('b')]);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(s.shown).toBe(1);
      expect(s.closed).toBe(2);
    });
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
