import { describe, expect, it } from 'vitest';
import { makeSearchProvider } from './index.js';
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
