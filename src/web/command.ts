import { join } from 'node:path';
import { resolveDefaultMode } from '../config.js';
import { createController } from '../controller.js';
import { startMode, type LastState } from '../laststate.js';
import type { createSession } from '../session.js';
import type { Config, Mode } from '../types.js';
import { PACKAGE_ROOT } from '../version.js';
import { clientAssets } from './assets.js';
import { createWebBridge } from './bridge.js';
import { startWebServer } from './server.js';
import { openWindow, type OpenedWindow } from './window.js';

// `reika web` (#584): one controller, the bridge and the local server in front of it. Ink-free, so
// cli.tsx can load it without React.

export type WebArgs = { port: number; window: boolean; help: boolean };

export const WEB_USAGE = `usage: reika web [--port <n>] [--window]   serve the agent to a browser tab on this machine (experimental)

  --port <n>    listen on this port (default: a free one)
  --window      open it in an app window (Chrome, Edge, Brave or Chromium); closing the
                window stops reika. Without one of those, a tab in the default browser
  -h, --help    show this

Prints a link that works once and for ten minutes; open it in a browser. Press Enter for a new
link (a second tab, or after it expires). ctrl-c stops the server.`;

// Null unless the first word is `web`, so every other command line falls through to the TUI and
// headless parsers. Throws on what it does not know, as parseHeadlessArgs does.
export function parseWebArgs(argv: string[]): WebArgs | null {
  if (argv[0] !== 'web') return null;
  const args: WebArgs = { port: 0, window: false, help: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || !(n >= 1 && n <= 65535)) {
        throw new Error(`--port needs a whole number from 1 to 65535\n${WEB_USAGE}`);
      }
      args.port = n;
    } else if (a === '--window') {
      args.window = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else {
      throw new Error(`unexpected argument ${a}\n${WEB_USAGE}`);
    }
  }
  return args;
}

export type WebIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  loadConfig: () => Config;
  // Injected so a test never reads or writes the developer's ~/.config/reika/state.json.
  loadLastState: () => LastState;
  saveLastState: (state: LastState) => void;
  defaultMode?: () => Mode;
  createSession?: typeof createSession;
  // The built page's directory; dist/web/ from source and from the bundle alike, since
  // PACKAGE_ROOT is the package root in both. From source it needs `pnpm run build:web` first.
  clientRoot?: string;
  // Injected so a test never launches a browser, or waits out the real delays.
  openWindow?: typeof openWindow;
  windowTimings?: Partial<typeof WINDOW_TIMINGS>;
};

// --window: how long the window may take to sign in before the terminal offers a link instead,
// and how long no page may be connected before reika stops. A reload reconnects well inside the
// second; Chrome on macOS outlives its last window, so the page, not the process, says it closed.
// `pageGoneMs` outlasts the page's longest reconnect wait (MAX_BACKOFF_MS in client/eventstream.ts,
// pinned by a test), or a slow reconnect would read as the window closing and stop reika.
export const WINDOW_TIMINGS = { signInMs: 20_000, pageGoneMs: 15_000 };

export type WebHandle = {
  url: string;
  port: number;
  // A fresh single-use link; the one before it stops working.
  newLink(): string;
  // Idempotent; the first call's code is the one `done` resolves with.
  shutdown(code?: number): Promise<void>;
  done: Promise<number>;
};

// An aborted turn appends its last rows after the abort returns; the save should hold them.
const ABORT_SETTLE_MS = 2000;

function waitUntilNotBusy(controller: ReturnType<typeof createController>): Promise<void> {
  if (controller.status !== 'busy') return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ABORT_SETTLE_MS);
    timer.unref();
    const unsubscribe = controller.subscribe(() => {
      if (controller.status !== 'busy') done();
    });
    function done(): void {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

// A number is a failure before anything listened (boot, or the port): exit with it.
export async function runWeb(args: WebArgs, io: WebIo): Promise<WebHandle | number> {
  const controller = createController({
    mode: startMode(io.loadLastState()),
    remember: io.saveLastState,
    ...(io.createSession ? { createSession: io.createSession } : {}),
    // The status line's PR. A test's injected session skips it: no git or gh from a test.
    pollPr: !io.createSession,
  });
  const session = await controller.boot({
    cwd: io.cwd,
    loadConfig: io.loadConfig,
    lastState: io.loadLastState(),
    defaultMode: (io.defaultMode ?? resolveDefaultMode)(),
  });
  if (!session) {
    io.stderr(`reika: ${controller.getSnapshot().error ?? 'could not start the session'}\n`);
    await controller.session?.mcp.close();
    return 1;
  }

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>(resolve => (resolveDone = resolve));
  let shutdownPromise: Promise<void> | null = null;
  // Set once listening; onExit comes from a tab, so only after that.
  let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
  let win: OpenedWindow | null = null;

  const bridge = createWebBridge(controller, { onExit: () => void shutdown(0) });

  const timings = { ...WINDOW_TIMINGS, ...io.windowTimings };
  let signedIn = false;
  let connected = false;
  let signInTimer: ReturnType<typeof setTimeout> | null = null;
  let goneTimer: ReturnType<typeof setTimeout> | null = null;
  const stopTimers = (): void => {
    if (signInTimer) clearTimeout(signInTimer);
    if (goneTimer) clearTimeout(goneTimer);
    signInTimer = goneTimer = null;
  };
  // The first sign-in is the window's own code, or one the terminal printed after it.
  const onLinkSpent = (): void => {
    if (!args.window || signedIn) return;
    signedIn = true;
    if (signInTimer) clearTimeout(signInTimer);
    void win?.codeSpent();
  };
  // Stopping when the last page goes, not when the window's process does: a second tab opened
  // from the terminal keeps reika running, as an app runs until its last window closes.
  const onStreamCount = (count: number): void => {
    if (!args.window || shutdownPromise) return;
    if (count > 0) {
      connected = true;
      if (goneTimer) clearTimeout(goneTimer);
      goneTimer = null;
      return;
    }
    if (!connected || goneTimer) return;
    goneTimer = setTimeout(() => {
      io.stdout('The window closed; stopping.\n');
      void shutdown(0);
    }, timings.pageGoneMs);
  };

  // Tabs first, so nothing new arrives; then the turn, so its last rows are in the save; then the
  // session's own children. The window closes beside the save rather than ahead of the abort, so a
  // running bash group is not left waiting on it.
  function shutdown(code = 0): Promise<void> {
    shutdownPromise ??= (async () => {
      try {
        stopTimers();
        await server?.close();
        bridge.close();
        const closingWindow = win?.close().catch(() => {});
        // stop, not abort: a line still asking its questions or fetching its links is not running
        // yet, and would start its turn during the save below.
        const running = controller.status === 'busy';
        controller.stop();
        if (running) await waitUntilNotBusy(controller);
        // A failed save must not leave the MCP servers running.
        await controller.saveNow().catch(() => {});
        await session!.mcp.close();
        await closingWindow;
      } finally {
        resolveDone(code);
      }
    })();
    return shutdownPromise;
  }

  try {
    server = await startWebServer(bridge, {
      port: args.port,
      assets: clientAssets(io.clientRoot ?? join(PACKAGE_ROOT, 'dist', 'web')),
      onLinkSpent,
      onStreamCount,
    });
  } catch (e) {
    bridge.close();
    await session.mcp.close();
    io.stderr(`reika: could not listen on port ${args.port}: ${(e as Error).message}\n`);
    return 1;
  }

  const header = `reika web (experimental) — ${session.config.model} in ${session.bundle.cwd}`;
  const linkNote = [
    'Only this machine can connect, and the link signs in one browser tab: it works once, within',
    'ten minutes. Press Enter for a new link. ctrl-c to stop.',
  ];
  if (!args.window) {
    io.stdout([header, '', `  ${server.url}`, '', ...linkNote, ''].join('\n'));
  } else {
    // The window takes the first link and the terminal never prints it: one code, one sign-in.
    try {
      win = await (io.openWindow ?? openWindow)(server.url);
    } catch (e) {
      io.stderr(`reika: could not open a window: ${(e as Error).message}\n`);
    }
    const listening = server;
    const offerLink = (why: string): void =>
      io.stdout([why, '', `  ${listening.newLink()}`, '', ...linkNote, ''].join('\n'));
    if (win?.kind === 'app') {
      io.stdout(
        [
          header,
          '',
          `Opened an app window in ${win.browser}; closing it stops reika.`,
          'Press Enter for a link to open in a second tab, ctrl-c to stop.',
          '',
        ].join('\n'),
      );
      void win.ended.then(outcome => {
        if (shutdownPromise) return;
        if (outcome === 'failed') {
          offerLink('The window closed as soon as it opened. Open this link instead:');
          return;
        }
        // Where the browser quits with its last window. Once a page has connected, the stream
        // count already saw it go and decides; a window closed before it ever signed in is
        // stopped on here.
        if (!connected) {
          io.stdout('The window closed; stopping.\n');
          void shutdown(0);
        }
      });
    } else if (win?.kind === 'tab') {
      io.stdout(
        [
          header,
          '',
          `Opened a tab in the default browser (${win.reason}); closing it stops reika.`,
          'Press Enter for a new link, ctrl-c to stop.',
          '',
        ].join('\n'),
      );
    } else {
      io.stdout([header, '', `  ${listening.newLink()}`, '', ...linkNote, ''].join('\n'));
    }
    if (win) {
      // A window that opened but cannot sign in (an error page, a browser that cannot read the
      // redirect file, a slow first start) shows nothing in the terminal otherwise.
      signInTimer = setTimeout(() => {
        signInTimer = null;
        if (signedIn || shutdownPromise) return;
        offerLink(
          'The window has not signed in yet. If it shows an error, open this link instead:',
        );
      }, timings.signInMs);
      signInTimer.unref();
    }
  }

  const listening = server;
  return {
    url: server.url,
    port: server.port,
    newLink: () => listening.newLink(),
    shutdown,
    done,
  };
}
