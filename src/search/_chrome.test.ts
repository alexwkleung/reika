import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChromeHost } from './_chrome.js';

// shutdown() asks /json/list before it goes near the browser target; reaching /json/version is
// the proof it decided to close. The version stub carries no debugger URL, so the test stops
// there without a WebSocket.
function stubCdp(tabs: { type: string; url: string }[]): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    requested.push(path);
    return new Response(JSON.stringify(path === '/json/list' ? tabs : {}));
  });
  return requested;
}

describe('ChromeHost idle shutdown', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves the browser up while another session has a search tab open', async () => {
    const requested = stubCdp([
      { type: 'page', url: 'about:blank' },
      { type: 'page', url: 'https://search.brave.com/search?q=x' },
    ]);
    await new ChromeHost().shutdown();
    expect(requested).toEqual(['/json/list']);
  });

  it('closes a browser holding only the launch tab and non-page targets', async () => {
    const requested = stubCdp([
      { type: 'page', url: 'about:blank' },
      { type: 'service_worker', url: 'https://search.brave.com/sw.js' },
    ]);
    await new ChromeHost().shutdown();
    expect(requested).toEqual(['/json/list', '/json/version']);
  });
});
