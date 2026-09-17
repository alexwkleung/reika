import { describe, expect, it } from 'vitest';
import { chatTools, defaultTools, makeSearchProvider } from './index.js';
import { CdpSearchProvider } from '../search/cdp.js';
import { SearxngProvider } from '../search/searxng.js';
import type { Config } from '../types.js';

const config = (over: Partial<Config>): Config => ({ ...over }) as Config;

describe('makeSearchProvider', () => {
  it('registers nothing when neither provider is configured', () => {
    expect(makeSearchProvider(config({}))).toBeUndefined();
    expect(makeSearchProvider(undefined)).toBeUndefined();
  });

  it('uses SearXNG when only it is configured', () => {
    expect(makeSearchProvider(config({ searxngUrl: 'http://localhost:8888' }))).toBeInstanceOf(
      SearxngProvider,
    );
  });

  it('uses CDP when the flag is set, with no SearXNG instance needed', () => {
    expect(makeSearchProvider(config({ cdpSearch: true }))).toBeInstanceOf(CdpSearchProvider);
  });

  // The stated rule from #235: CDP outranks SearXNG. SearXNG reaches engines as a bare HTTP client
  // and gets CAPTCHA'd for it, so when both are available the browser is the one that stays served.
  it('prefers CDP over SearXNG when both are configured', () => {
    const provider = makeSearchProvider(
      config({ cdpSearch: true, searxngUrl: 'http://localhost:8888' }),
    );
    expect(provider).toBeInstanceOf(CdpSearchProvider);
  });

  it('falls back to SearXNG when the CDP flag is off', () => {
    const provider = makeSearchProvider(
      config({ cdpSearch: false, searxngUrl: 'http://localhost:8888' }),
    );
    expect(provider).toBeInstanceOf(SearxngProvider);
  });
});

// #392: no route out at startup → neither web tool in the list. A tool the model can see is a
// tool it will call, and every call would fail.
describe('tool lists — offline', () => {
  const names = (tools: { name: string }[]) => tools.map(t => t.name);

  it('drops search and fetch_url from the agent list, keeping everything else', () => {
    const cfg = config({ searxngUrl: 'http://localhost:8888' });
    const online = names(defaultTools(cfg));
    const offline = names(defaultTools(cfg, { offline: true }));
    expect(online).toEqual(expect.arrayContaining(['search', 'fetch_url']));
    expect(offline).not.toContain('search');
    expect(offline).not.toContain('fetch_url');
    expect(offline).toEqual(online.filter(n => n !== 'search' && n !== 'fetch_url'));
  });

  it('leaves chat mode with no tools at all', () => {
    const cfg = config({ searxngUrl: 'http://localhost:8888' });
    expect(names(chatTools(cfg))).toEqual(['fetch_url', 'search']);
    expect(chatTools(cfg, { offline: true })).toEqual([]);
  });

  it('changes nothing when online', () => {
    const cfg = config({});
    expect(names(defaultTools(cfg, { offline: false }))).toEqual(names(defaultTools(cfg)));
    expect(names(chatTools(cfg, {}))).toEqual(['fetch_url']);
  });
});
