import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { debugLog } from '../debug.js';
import { SearchUnavailableError } from './types.js';

// A tab, as the search provider needs it. The provider depends on this and nothing else, so its
// extraction and parsing are testable without a browser on the machine running the suite.
export interface TabHandle {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserHost {
  newTab(): Promise<TabHandle>;
}

const DEFAULT_PORT = 9222;
const LAUNCH_TIMEOUT_MS = 20_000;
const LAUNCH_POLL_MS = 150;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
// Chrome is ~375MB resident. ds4 never kills it ("keeping it alive makes repeated web tool calls
// cheaper and less suspicious") but ds4 isn't sharing a 16GB machine with a local model. Ten idle
// minutes keeps a burst of searches on one warm browser while not holding the memory all session.
// The profile lives on disk, so cookies survive the kill and only the process cost is reclaimed.
const IDLE_SHUTDOWN_MS = 10 * 60_000;

export type ChromeOptions = {
  port?: number;
  binary?: string;
  profileDir?: string;
};

export class ChromeHost implements BrowserHost {
  private readonly port: number;
  private readonly binary?: string;
  private readonly profileDir: string;
  private idleTimer?: NodeJS.Timeout;
  private launching?: Promise<void>;

  constructor(opts: ChromeOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.binary = opts.binary;
    this.profileDir = opts.profileDir ?? join(homedir(), '.config', 'reika', 'chrome');
  }

  async newTab(): Promise<TabHandle> {
    await this.ensure();
    this.touch();
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new`, { method: 'PUT' });
    if (!res.ok) throw new Error(`could not open a tab (CDP ${res.status})`);
    const tab = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string };
    if (!tab.webSocketDebuggerUrl || !tab.id)
      throw new Error('CDP returned a tab with no debugger URL');
    const session = await openSession(tab.webSocketDebuggerUrl);
    const port = this.port;
    const touch = () => this.touch();
    return {
      async navigate(url: string) {
        touch();
        await session.call('Page.enable');
        await session.call('Page.navigate', { url });
        await waitForReady(session, url);
      },
      async evaluate(expression: string) {
        touch();
        const res = await session.call('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return (res as { result?: { result?: { value?: unknown } } }).result?.result?.value;
      },
      async close() {
        session.close();
        // Best-effort: a leaked tab costs memory but must never fail a search that already answered.
        try {
          await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
        } catch {
          /* ignore */
        }
      },
    };
  }

  // Reattach beats relaunch: an already-running instance on this port is warm, and launching a
  // second one against the same profile dir fails outright (Chrome holds a lock on it).
  private async ensure(): Promise<void> {
    if (await this.alive()) return;
    // Concurrent searches in one turn must not race two launches at the same profile.
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = undefined;
      });
    }
    return this.launching;
  }

  private async alive(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async launch(): Promise<void> {
    const exe = this.binary ?? findChrome();
    if (!exe) {
      throw new SearchUnavailableError(
        'no Chrome or Chromium found',
        'CDP search needs a browser. Install Chrome or Chromium, set REIKA_CHROME_PATH to its binary, or unset REIKA_CDP_SEARCH to fall back to SearXNG.',
      );
    }
    mkdirSync(this.profileDir, { recursive: true });
    const flags = [
      `--remote-debugging-port=${this.port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--password-store=basic',
      '--mute-audio',
      'about:blank',
    ];
    debugLog(`[cdp] launching ${exe} on port ${this.port}`);
    // Not headless, deliberately: a fresh headless profile is the shape search engines CAPTCHA.
    // macOS `open -g -na` starts a real browser that never takes focus or shows a window, which is
    // the same end the headless flag was wanted for without raising the detection surface.
    if (platform() === 'darwin' && !this.binary) {
      spawn('/usr/bin/open', ['-g', '-na', macAppName() ?? 'Google Chrome', '--args', ...flags], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      spawn(exe, flags, { detached: true, stdio: 'ignore' }).unref();
    }
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.alive()) {
        debugLog(`[cdp] browser ready on port ${this.port}`);
        return;
      }
      await sleep(LAUNCH_POLL_MS);
    }
    throw new Error(`Chrome did not expose a debugging port within ${LAUNCH_TIMEOUT_MS}ms`);
  }

  // Idle shutdown only ever kills a browser this process launched *and* that nothing has used for
  // the full window. Unref'd so a pending timer can't hold the CLI open at exit.
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.shutdown(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // Closing the browser is a CDP call on the *browser* target, not an HTTP path — /json/close
    // takes a tab id, so the earlier spelling silently did nothing and left Chrome resident.
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (!webSocketDebuggerUrl) return;
      const session = await openSession(webSocketDebuggerUrl);
      await session.call('Browser.close').catch(() => undefined);
      session.close();
    } catch {
      /* already gone */
    }
    debugLog('[cdp] browser shut down after idle timeout');
  }
}

// readyState alone is not enough: it reads `complete` for the document still on screen while the
// navigation is in flight, so a fast poll extracts from the *previous* page — in practice the
// about:blank a new tab starts on, which looks exactly like a search that found nothing. Probe the
// committed URL and a non-empty body alongside it, the way ds4's web_page_probe does.
async function waitForReady(session: CdpSession, target: string): Promise<void> {
  const origin = originOf(target);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await session.call('Runtime.evaluate', {
      expression:
        "JSON.stringify({href:location.href,ready:document.readyState,len:(document.body&&document.body.innerText||'').length})",
      returnByValue: true,
    });
    const raw = (res as { result?: { result?: { value?: unknown } } }).result?.result?.value;
    if (typeof raw === 'string') {
      try {
        const probe = JSON.parse(raw) as { href?: string; ready?: string; len?: number };
        const committed = !!probe.href && (!origin || probe.href.startsWith(origin));
        if (committed && probe.ready === 'complete' && (probe.len ?? 0) > 0) return;
      } catch {
        /* keep polling */
      }
    }
    await sleep(READY_POLL_MS);
  }
  // Not fatal: a SERP with a slow third-party beacon still has its results in the DOM.
  debugLog('[cdp] page never settled; extracting anyway');
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// Chrome's own locations first, then PATH. Mirrors ds4's discovery order.
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.REIKA_CHROME_PATH?.trim();
  if (override) return override;
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function macAppName(): string | undefined {
  for (const [app, probe] of [
    ['Google Chrome', '/Applications/Google Chrome.app'],
    ['Chromium', '/Applications/Chromium.app'],
  ]) {
    try {
      accessSync(probe, constants.F_OK);
      return app;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Minimal CDP client. Node 23 ships a global WebSocket and JSON, so the whole
// protocol is a request id, a send, and a map of pending resolvers — no dependency.
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 20_000;

export type CdpSession = {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

export async function openSession(wsUrl: string): Promise<CdpSession> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), {
      once: true,
    });
  });
  let nextId = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.addEventListener('message', event => {
    let msg: { id?: number };
    try {
      msg = JSON.parse(String((event as MessageEvent).data));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, CALL_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, value => {
          clearTimeout(timer);
          resolve(value);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      pending.clear();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
