import type * as ChildProcess from 'node:child_process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBrowserCloseScript, ChromeHost } from './_chrome.js';

const spawnedDetached = vi.hoisted(() => vi.fn(() => ({ unref() {} })));
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnedDetached,
}));

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

describe('ChromeHost exit close', () => {
  const exitListenersBefore = process.listeners('exit');

  afterEach(() => {
    vi.unstubAllGlobals();
    spawnedDetached.mockClear();
    for (const listener of process.listeners('exit'))
      if (!exitListenersBefore.includes(listener)) process.off('exit', listener);
  });

  const addedExitListeners = () =>
    process.listeners('exit').filter(listener => !exitListenersBefore.includes(listener));

  // newTab fails right after ensure() on the stub's empty /json/version, which is as far as these
  // tests need: the browser is up, and whether this process launched it is decided.
  function stubBrowser(upBeforeLaunch: boolean) {
    let up = upBeforeLaunch;
    vi.stubGlobal('fetch', async (url: string) => {
      if (!up) throw new Error('connection refused');
      const path = new URL(url).pathname;
      return new Response(path === '/json/list' ? '[]' : '{}');
    });
    return () => {
      up = true;
    };
  }

  async function launch(host: ChromeHost) {
    const markUp = stubBrowser(false);
    spawnedDetached.mockImplementationOnce(() => {
      markUp();
      return { unref() {} };
    });
    await host.newTab().catch(() => undefined);
  }

  it('closes a browser this process launched', async () => {
    await launch(new ChromeHost({ binary: '/bin/chrome', port: 9555 }));
    spawnedDetached.mockClear();
    for (const listener of addedExitListeners()) listener(0);
    const [exe, args] = spawnedDetached.mock.calls[0] as unknown as [string, string[]];
    expect(exe).toBe(process.execPath);
    expect(args[1]).toContain('127.0.0.1:9555');
  });

  it("leaves a browser it only reattached to, which may be the user's own", async () => {
    stubBrowser(true);
    await new ChromeHost().newTab().catch(() => undefined);
    expect(addedExitListeners()).toEqual([]);
  });

  it('has nothing left to close once the idle shutdown finds the browser gone', async () => {
    const host = new ChromeHost({ binary: '/bin/chrome' });
    await launch(host);
    expect(addedExitListeners()).toHaveLength(1);
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });
    await host.shutdown();
    expect(addedExitListeners()).toEqual([]);
  });

  it('does not stack a second close when the same host launches again', async () => {
    const host = new ChromeHost({ binary: '/bin/chrome' });
    await launch(host);
    await launch(host);
    expect(addedExitListeners()).toHaveLength(1);
  });
});

describe('buildBrowserCloseScript', () => {
  const run = promisify(execFile);
  const launchTab = { id: 'launch', type: 'page', url: 'about:blank' };
  const searchUrl = 'https://search.brave.com/search?q=x';

  // One tab list per look; the last repeats, so a run that keeps looking is visible in the count.
  async function requestsMadeBy(...looks: { id: string; type: string; url: string }[][]) {
    const requested: string[] = [];
    let listed = 0;
    const server = createServer((req, res) => {
      requested.push(req.url ?? '');
      const tabs = looks[Math.min(listed, looks.length - 1)];
      if (req.url === '/json/list') listed++;
      res.end(JSON.stringify(req.url === '/json/list' ? tabs : {}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await run(process.execPath, ['-e', buildBrowserCloseScript(port, 20)]);
    server.close();
    return requested;
  }

  it('leaves the browser up while a search or a bot check holds a tab', async () => {
    const requested = await requestsMadeBy([
      launchTab,
      { id: 'search', type: 'page', url: searchUrl },
    ]);
    expect(requested).toEqual(['/json/list']);
  });

  it('goes on to close a browser holding only the launch tab, after looking twice', async () => {
    const requested = await requestsMadeBy([launchTab]);
    expect(requested).toEqual(['/json/list', '/json/list', '/json/version']);
  });

  it('leaves the browser up when a blank tab turns out to be a search navigating', async () => {
    const newTab = { id: 'search', type: 'page', url: 'about:blank' };
    const requested = await requestsMadeBy(
      [launchTab, newTab],
      [launchTab, { ...newTab, url: searchUrl }],
    );
    expect(requested).toEqual(['/json/list', '/json/list']);
  });

  it('leaves the browser up when a tab opens between the two looks', async () => {
    const newTab = { id: 'search', type: 'page', url: 'about:blank' };
    const requested = await requestsMadeBy([launchTab], [launchTab, newTab]);
    expect(requested).toEqual(['/json/list', '/json/list']);
  });

  it('exits quietly when no browser is listening', async () => {
    await expect(
      run(process.execPath, ['-e', buildBrowserCloseScript(1, 20)]),
    ).resolves.toBeDefined();
  });
});
