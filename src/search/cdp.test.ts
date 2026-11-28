import { describe, expect, it } from 'vitest';
import { CdpSearchProvider, DATE_LINE } from './cdp.js';
import { findChrome, type BrowserHost, type TabHandle } from './_chrome.js';
import { BRAVE, DUCKDUCKGO, type SearchEngine } from './engines.js';
import type { LinkRecord } from './extract.js';
import { SearchUnavailableError } from './types.js';

type Spy = { navigated: string[]; closed: number; shown: number; hidden: number };
const spy = (): Spy => ({ navigated: [], closed: 0, shown: 0, hidden: 0 });

// The provider depends only on BrowserHost, so the flow is exercised without a browser on the
// machine running the suite — the page's answer is the thing under test. A list of values plays a
// page that changes under polling (a challenge the user then solves); the last value repeats once
// the list is spent. Keyed by engine, a host answers each engine's page from its own list.
function hostReturning(value: unknown | unknown[], s?: Spy): BrowserHost {
  return hostByEngine({ duckduckgo: value, brave: value }, s);
}

function hostByEngine(
  values: Partial<Record<SearchEngine['name'], unknown | unknown[]>>,
  s?: Spy,
): BrowserHost {
  const queues = new Map<string, unknown[]>();
  for (const [name, v] of Object.entries(values)) queues.set(name, Array.isArray(v) ? [...v] : [v]);
  return {
    async newTab(): Promise<TabHandle> {
      let engine = '';
      return {
        async navigate(url: string) {
          s?.navigated.push(url);
          engine = url.includes('duckduckgo') ? 'duckduckgo' : 'brave';
        },
        async evaluate() {
          const pages = queues.get(engine) ?? [page([])];
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
// page always gets to its last state. Timeout tests pass their own zero wait. One engine unless a
// test is about the order between them.
const fast = { challengeWaitMs: 5_000, challengePollMs: 0 };
const cdp = (host: BrowserHost, engines: SearchEngine[] = [DUCKDUCKGO]) =>
  new CdpSearchProvider(host, { ...fast, engines });
// A check nobody clears: the raise happens, the wait expires at once.
const unsolved = (host: BrowserHost, engines: SearchEngine[] = [DUCKDUCKGO]) =>
  new CdpSearchProvider(host, { challengeWaitMs: 0, challengePollMs: 0, engines });

type Result = { title: string; url: string; snippet?: string };
const link = (r: Result): LinkRecord => ({
  href: r.url,
  inner: r.title,
  text: r.title,
  visible: true,
  chrome: false,
  snippet: r.snippet ?? '',
});
// `anchors` defaults high: a real results page has dozens of links even when it matches nothing,
// and the provider reads a near-empty page as an interstitial rather than an answered search.
const page = (results: Result[], opts: { challenge?: boolean; anchors?: number } = {}) =>
  JSON.stringify({
    links: results.map(link),
    anchors: opts.anchors ?? 40,
    bodyText: opts.challenge ? "Verifying you're not a bot" : 'results',
  });
const challengePage = page([], { challenge: true });

const results = (n: number, host = 'docs') =>
  Array.from({ length: n }, (_, i) => ({
    title: `Result number ${i}`,
    url: `https://${host}${i}.example/page`,
  }));
const solved = [{ title: 'Docs for the thing', url: 'https://docs.example/a', snippet: 'x' }];

describe('CdpSearchProvider', () => {
  it('asks DuckDuckGo first by default — the engine whose results carry their real addresses', async () => {
    const s = spy();
    const provider = new CdpSearchProvider(hostReturning(page(results(8)), s), fast);
    await provider.search('typescript satisfies operator');
    expect(s.navigated).toHaveLength(1);
    expect(s.navigated[0]).toContain('html.duckduckgo.com/html/?q=');
    expect(s.navigated[0]).toContain('typescript%20satisfies%20operator');
  });

  it('normalizes results and marks the engine that answered', async () => {
    const provider = cdp(
      hostReturning(
        page([
          {
            title: 'libuv process docs',
            url: 'https://docs.libuv.org/en/v1.x/process.html',
            snippet: 'uv_kill',
          },
        ]),
      ),
    );
    await expect(provider.search('q')).resolves.toEqual([
      {
        title: 'libuv process docs',
        url: 'https://docs.libuv.org/en/v1.x/process.html',
        snippet: 'uv_kill',
        source: 'duckduckgo',
      },
    ]);
  });

  it('caps at maxResults', async () => {
    const provider = cdp(hostReturning(page(results(20))));
    await expect(provider.search('q', { maxResults: 5 })).resolves.toHaveLength(5);
  });

  // #1130: an engine whose page changed does not fail, it answers with one stray link. Only the
  // count tells that from a real answer, so too few results asks the next engine as well.
  describe('falling back to the next engine', () => {
    it('asks Brave when DuckDuckGo gives too few, and keeps DuckDuckGo first', async () => {
      const s = spy();
      const host = hostByEngine(
        { duckduckgo: page(results(1, 'ddg')), brave: page(results(4, 'brave')) },
        s,
      );
      const out = await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(s.navigated).toHaveLength(2);
      expect(out[0]).toMatchObject({ url: 'https://ddg0.example/page', source: 'duckduckgo' });
      expect(out.slice(1).every(r => r.source === 'brave')).toBe(true);
      expect(out).toHaveLength(5);
    });

    it('does not ask the next engine when the first answers well enough', async () => {
      const s = spy();
      const host = hostByEngine({ duckduckgo: page(results(3)), brave: page(results(8, 'b')) }, s);
      await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(s.navigated).toHaveLength(1);
    });

    it('lists a page both engines returned once', async () => {
      const shared = { title: 'The same page twice', url: 'https://same.example/x' };
      const host = hostByEngine({
        duckduckgo: page([shared]),
        brave: page([shared, ...results(2, 'b')]),
      });
      const out = await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(out.map(r => r.url)).toEqual([
        'https://same.example/x',
        'https://b0.example/page',
        'https://b1.example/page',
      ]);
    });

    it('falls back past an engine whose page failed to load', async () => {
      const host = hostByEngine({ duckduckgo: '<!doctype html>', brave: page(results(4)) });
      const out = await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(out).toHaveLength(4);
      expect(out[0].source).toBe('brave');
    });

    it('routes around a challenge another engine can answer, without raising the window', async () => {
      const s = spy();
      const host = hostByEngine({ duckduckgo: challengePage, brave: page(results(4)) }, s);
      const out = await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(out).toHaveLength(4);
      expect(s.shown).toBe(0);
    });

    it('raises the challenge when the other engines answered too little, and leads with its results', async () => {
      const s = spy();
      const host = hostByEngine(
        { duckduckgo: [challengePage, challengePage, page(solved)], brave: page(results(1, 'b')) },
        s,
      );
      const out = await cdp(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(s.shown).toBe(1);
      expect(out.map(r => r.url)).toEqual(['https://docs.example/a', 'https://b0.example/page']);
    });

    it('keeps the other engines’ results when nobody clears the check', async () => {
      const host = hostByEngine({ duckduckgo: challengePage, brave: page(results(1, 'b')) });
      const out = await unsolved(host, [DUCKDUCKGO, BRAVE]).search('q');
      expect(out.map(r => r.url)).toEqual(['https://b0.example/page']);
    });
  });

  // #236's principle applied to this provider: a refused search must not read as an empty one, or
  // the model concludes its query was bad and rewords against a wall that refuses every variant.
  it('raises on an uncleared bot check rather than reporting an empty result set', async () => {
    const provider = unsolved(hostReturning(challengePage));
    await expect(provider.search('q')).rejects.toThrow(/bot check/);
  });

  it('raises the typed provider-level failure on a bot check, so the turn latches', async () => {
    const provider = unsolved(hostReturning(challengePage));
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
    const provider = cdp(hostReturning(page([])), [DUCKDUCKGO, BRAVE]);
    await expect(provider.search('q')).resolves.toEqual([]);
  });

  // The phrase list cannot be complete — the challenge that prompted this check reads "Verifying
  // you're not a bot", which none of the obvious phrasings would have matched. So the page's shape
  // has to carry the verdict too: a results page with almost no links is an interstitial, not a miss.
  it('raises on a near-empty page even when no known challenge phrase appears', async () => {
    const provider = unsolved(hostReturning(page([], { anchors: 3 })));
    await expect(provider.search('q')).rejects.toThrow(/no result list \(3 links/);
  });

  it('matches the wording each engine actually serves', async () => {
    for (const [engine, text] of [
      [BRAVE, "Verifying you're not a bot"],
      [
        DUCKDUCKGO,
        'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge',
      ],
    ] as const) {
      const body = JSON.stringify({ links: [], anchors: 3, bodyText: text });
      await expect(unsolved(hostReturning(body), [engine]).search('q')).rejects.toThrow(
        /bot check/,
      );
    }
  });

  it('does not read a page with results as a wall because a snippet quotes the wording', async () => {
    const quoting = JSON.stringify({
      links: results(5).map(link),
      anchors: 40,
      bodyText: 'Why do I see "unusual traffic from your computer network"?',
    });
    await expect(cdp(hostReturning(quoting)).search('q')).resolves.toHaveLength(5);
  });

  it('closes the tab when the search fails for a reason a human cannot clear', async () => {
    const s = spy();
    const provider = cdp(hostReturning('<!doctype html>', s));
    await expect(provider.search('q')).rejects.toThrow();
    expect(s.closed).toBe(1);
  });

  // #238: a bot check is a gate only a human can open, and the solve sticks on the profile. So the
  // provider surfaces the window, waits for the page to turn into results, and carries on — the
  // search that hit the check is the one that answers, and no budget is spent on a retry.
  describe('bot check recovery', () => {
    it('raises the window, waits for the check to clear, and answers the same search', async () => {
      const s = spy();
      const states: string[] = [];
      const provider = cdp(
        hostReturning([challengePage, challengePage, challengePage, page(solved), page(solved)], s),
      );
      const out = await provider.search('q', { onChallenge: st => states.push(st) });
      expect(out.map(r => r.url)).toEqual(['https://docs.example/a']);
      expect(s.shown).toBe(1);
      expect(states).toEqual(['raised', 'cleared']);
    });

    it('puts the window back down once the check has cleared', async () => {
      const s = spy();
      const provider = cdp(hostReturning([challengePage, challengePage, page(solved)], s));
      await provider.search('q');
      expect(s.hidden).toBe(1);
      // The first look, which only noted the challenge, and the tab that answered.
      expect(s.closed).toBe(2);
    });

    it('keeps polling through a probe that fails mid-navigation', async () => {
      const s = spy();
      const provider = cdp(
        hostReturning(
          [challengePage, challengePage, undefined, '<!doctype html>', page(solved)],
          s,
        ),
      );
      await expect(provider.search('q')).resolves.toHaveLength(1);
      expect(s.shown).toBe(1);
    });

    it('treats a near-empty page as a check to raise, not a wall to report', async () => {
      const s = spy();
      const nearEmpty = page([], { anchors: 3 });
      const provider = cdp(hostReturning([nearEmpty, nearEmpty, page(solved)], s));
      await expect(provider.search('q')).resolves.toHaveLength(1);
      expect(s.shown).toBe(1);
    });

    it('fails the turn when nobody clears the check, and leaves the raised tab open', async () => {
      const s = spy();
      const states: string[] = [];
      const provider = unsolved(hostReturning(challengePage, s));
      const err = await provider
        .search('q', { onChallenge: st => states.push(st) })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SearchUnavailableError);
      expect(states).toEqual(['raised']);
      // The check is still on that tab; closing it would take it away from the user who was just
      // told to complete it, and minimizing would hide it from them. Only the first look closed.
      expect(s.closed).toBe(1);
      expect(s.hidden).toBe(0);
    });

    it('reports a wall that survives the solve as a failure, not a second challenge', async () => {
      const s = spy();
      // Challenged, solved (the probe sees results), then the reload lands on something with no
      // result list at all.
      const provider = cdp(
        hostReturning([challengePage, challengePage, page(solved), page([], { anchors: 2 })], s),
      );
      await expect(provider.search('q')).rejects.toThrow(/no result list \(2 links/);
      expect(s.shown).toBe(1);
      expect(s.closed).toBe(2);
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
              return solvedAt > 0 && probes > 1 ? page(solved) : challengePage;
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

describe('DATE_LINE', () => {
  it('matches the date lines Brave ends some result anchors with', () => {
    for (const l of ['May 8, 2026', 'April 1, 2026', 'Sept. 3, 2025', '3 days ago', '1 year ago'])
      expect(DATE_LINE.test(l), l).toBe(true);
  });

  it('leaves titles that merely contain a date or a month', () => {
    for (const l of [
      'Release notes for May 8, 2026 update',
      'March of the Penguins review',
      'GitHub - kepano/defuddle: Get the main content of any page as Markdown.',
    ])
      expect(DATE_LINE.test(l), l).toBe(false);
  });
});
