import { describe, expect, it } from 'vitest';
import {
  chatTools,
  chooseSearchBackend,
  defaultTools,
  makeSearchProvider,
  searchPrecedenceNotice,
  type SearchProbe,
} from './index.js';
import { CdpSearchProvider } from '../search/cdp.js';
import { SearxngProvider } from '../search/searxng.js';
import type { Config } from '../types.js';

const config = (over: Partial<Config>): Config => ({ ...over }) as Config;
const SEARXNG = 'http://localhost:8888';
const mac: SearchProbe = { platform: 'darwin', hasChrome: () => true };
const macNoChrome: SearchProbe = { platform: 'darwin', hasChrome: () => false };
const linux: SearchProbe = { platform: 'linux', hasChrome: () => true };

describe('makeSearchProvider', () => {
  it('registers nothing when neither provider is configured', () => {
    expect(makeSearchProvider(config({}), mac)).toBeUndefined();
    expect(makeSearchProvider(undefined, mac)).toBeUndefined();
  });

  it('uses SearXNG when only it is configured', () => {
    expect(makeSearchProvider(config({ searxngUrl: SEARXNG }), mac)).toBeInstanceOf(
      SearxngProvider,
    );
  });

  it('uses CDP when the flag is on, with no SearXNG instance needed', () => {
    expect(makeSearchProvider(config({ cdpSearch: 'on' }), mac)).toBeInstanceOf(CdpSearchProvider);
  });

  // The stated rule from #235: CDP outranks SearXNG. SearXNG reaches engines as a bare HTTP client
  // and gets CAPTCHA'd for it, so when both are available the browser is the one that stays served.
  it('prefers CDP over SearXNG when both are configured', () => {
    const cfg = config({ cdpSearch: 'on', searxngUrl: SEARXNG });
    expect(makeSearchProvider(cfg, mac)).toBeInstanceOf(CdpSearchProvider);
    expect(
      makeSearchProvider(config({ cdpSearch: 'auto', searxngUrl: SEARXNG }), mac),
    ).toBeInstanceOf(CdpSearchProvider);
  });

  it('falls back to SearXNG when the CDP flag is off', () => {
    const cfg = config({ cdpSearch: 'off', searxngUrl: SEARXNG });
    expect(makeSearchProvider(cfg, mac)).toBeInstanceOf(SearxngProvider);
  });

  // A hand-built Config predating the knob must not probe for a browser: undefined is 'off'.
  it('treats an unset cdpSearch as off', () => {
    expect(chooseSearchBackend(config({}), mac).backend).toBeUndefined();
  });
});

describe('chooseSearchBackend — auto', () => {
  it('uses a detected Chrome on macOS', () => {
    expect(chooseSearchBackend(config({ cdpSearch: 'auto' }), mac)).toEqual({
      backend: 'cdp',
      cdpVia: 'detected',
      searxngShadowed: false,
    });
  });

  it('falls through to SearXNG, then nothing, when macOS has no Chrome', () => {
    expect(
      chooseSearchBackend(config({ cdpSearch: 'auto', searxngUrl: SEARXNG }), macNoChrome).backend,
    ).toBe('searxng');
    expect(chooseSearchBackend(config({ cdpSearch: 'auto' }), macNoChrome).backend).toBeUndefined();
  });

  // Off macOS the launch spawns a visible window that takes focus, so CDP is opt-in there.
  it('never auto-selects CDP off macOS, even with Chrome installed', () => {
    expect(chooseSearchBackend(config({ cdpSearch: 'auto' }), linux).backend).toBeUndefined();
    expect(
      chooseSearchBackend(config({ cdpSearch: 'auto', searxngUrl: SEARXNG }), linux).backend,
    ).toBe('searxng');
  });

  it('lets Linux opt in explicitly', () => {
    expect(chooseSearchBackend(config({ cdpSearch: 'on' }), linux).backend).toBe('cdp');
  });

  // 'on' is a demand, not a probe: without a browser it still picks CDP so the first search fails
  // loudly with the install remedy, rather than silently searching somewhere else.
  it('does not probe when the flag is on', () => {
    let probed = false;
    const probe: SearchProbe = { platform: 'darwin', hasChrome: () => ((probed = true), false) };
    expect(chooseSearchBackend(config({ cdpSearch: 'on' }), probe).backend).toBe('cdp');
    expect(probed).toBe(false);
  });
});

describe('searchPrecedenceNotice', () => {
  it('says nothing unless SearXNG is configured and outranked', () => {
    expect(
      searchPrecedenceNotice(chooseSearchBackend(config({ cdpSearch: 'auto' }), mac)),
    ).toBeUndefined();
    expect(
      searchPrecedenceNotice(
        chooseSearchBackend(config({ cdpSearch: 'off', searxngUrl: SEARXNG }), mac),
      ),
    ).toBeUndefined();
  });

  it('names the winner and the way back when both are configured', () => {
    const detected = searchPrecedenceNotice(
      chooseSearchBackend(config({ cdpSearch: 'auto', searxngUrl: SEARXNG }), mac),
    );
    expect(detected).toMatch(/found automatically/);
    expect(detected).toMatch(/REIKA_CDP_SEARCH=0/);
    const flagged = searchPrecedenceNotice(
      chooseSearchBackend(config({ cdpSearch: 'on', searxngUrl: SEARXNG }), mac),
    );
    expect(flagged).not.toMatch(/found automatically/);
    expect(flagged).toMatch(/takes precedence over REIKA_SEARXNG_URL/);
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
