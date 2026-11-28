import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAVE, DUCKDUCKGO } from './engines.js';
import { pickResults, titleOf, type LinkRecord, type PageRecord } from './extract.js';

// Links recorded with `collectScript()` from real result pages on 2026-11-27, trimmed (#1130). When
// an engine redesigns its page, record the new one the same way and replace its entry: a test that
// fails here is the redesign reaching the suite instead of reaching the model as empty results.
const corpus = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'extract.corpus.json'), 'utf8'),
) as Record<string, PageRecord>;

const hostOf = (url: string) => new URL(url).hostname;

describe('pickResults on recorded result pages', () => {
  it('reads DuckDuckGo’s ranked results, with their real addresses and titles', () => {
    const out = pickResults(corpus['duckduckgo-coding'], DUCKDUCKGO, 8);
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal',
      title: 'AbortSignal - Web APIs - MDN',
    });
    expect(out.map(r => r.url)).toContain('https://github.com/node-fetch/timeout-signal');
    // The description is a link of its own on this page, so it comes from the sibling link.
    expect(out.every(r => r.snippet.length > 40)).toBe(true);
    expect(out.find(r => r.url.includes('timeout-signal'))?.snippet).toMatch(
      /^Create an AbortSignal that aborts after a delay/,
    );
    expect(out.every(r => r.snippet !== r.title)).toBe(true);
    // Decoded from the `uddg` parameter, never DuckDuckGo's own redirect.
    expect(out.every(r => !hostOf(r.url).endsWith('duckduckgo.com'))).toBe(true);
  });

  it('reads a general query on DuckDuckGo the same way', () => {
    const out = pickResults(corpus['duckduckgo-general'], DUCKDUCKGO, 8);
    expect(out).toHaveLength(8);
    expect(out.map(r => hostOf(r.url))).toContain('www.bbcgoodfood.com');
    expect(out.every(r => r.title.length >= 8 && !r.title.startsWith('http'))).toBe(true);
  });

  // Brave's ranked results link to `/go/v1#<token>`, with the destination nowhere on the page, so
  // a coding query keeps only the odd direct link. What must not happen is its footer filling in.
  it('keeps Brave’s footer out of the results', () => {
    for (const name of ['brave-coding', 'brave-general']) {
      const out = pickResults(corpus[name], BRAVE, 8);
      expect(
        out.map(r => hostOf(r.url)),
        name,
      ).not.toContain('hackerone.com');
      expect(out.every(r => !/brave\.(com|app)$/.test(hostOf(r.url)))).toBe(true);
    }
    expect(pickResults(corpus['brave-coding'], BRAVE, 8).map(r => hostOf(r.url))).toEqual([
      'tools.belchamber.us',
    ]);
  });

  it('keeps the direct links Brave still serves on a general query', () => {
    const hosts = pickResults(corpus['brave-general'], BRAVE, 8).map(r => hostOf(r.url));
    expect(hosts).toContain('cooking.nytimes.com');
    expect(hosts).toContain('www.bbcgoodfood.com');
  });
});

const link = (over: Partial<LinkRecord>): LinkRecord => ({
  href: 'https://site.example/page',
  inner: 'A result title',
  text: 'A result title',
  visible: true,
  chrome: false,
  snippet: '',
  ...over,
});
const pageOf = (links: LinkRecord[]): PageRecord => ({ links, anchors: 40, bodyText: '' });

describe('pickResults', () => {
  it('skips links inside the page’s header, footer and navigation', () => {
    const out = pickResults(
      pageOf([link({ href: 'https://hackerone.com/brave', chrome: true }), link({})]),
      BRAVE,
      8,
    );
    expect(out.map(r => r.url)).toEqual(['https://site.example/page']);
  });

  it('decodes a DuckDuckGo link from its uddg parameter, without following it', () => {
    const href =
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fnode-fetch%2Ftimeout-signal&rut=abc';
    expect(pickResults(pageOf([link({ href })]), DUCKDUCKGO, 8)[0].url).toBe(
      'https://github.com/node-fetch/timeout-signal',
    );
  });

  it('drops an engine’s own links and anything that is not a web page', () => {
    const out = pickResults(
      pageOf([
        link({ href: 'https://duckduckgo.com/settings' }),
        link({ href: 'https://duck.ai/' }),
        link({ href: 'mailto:someone@example.com' }),
        link({ href: 'https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)' }),
      ]),
      DUCKDUCKGO,
      8,
    );
    expect(out).toEqual([]);
  });

  it('keeps at most two results per host', () => {
    const links = [1, 2, 3].map(i => link({ href: `https://one.example/${i}` }));
    expect(pickResults(pageOf(links), DUCKDUCKGO, 8)).toHaveLength(2);
  });
});

describe('titleOf', () => {
  it('takes the last line, past a site name and a breadcrumb', () => {
    expect(titleOf(link({ inner: 'GitHub\nhttps://github.com › x › y\nThe real title' }))).toBe(
      'The real title',
    );
  });

  // A minimized window reports its document hidden, and innerText then comes back empty for some
  // elements while textContent still has the words.
  it('falls back to textContent when innerText is empty', () => {
    expect(titleOf(link({ inner: '', text: 'Words only textContent had' }))).toBe(
      'Words only textContent had',
    );
  });
});
