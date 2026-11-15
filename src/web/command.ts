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

// `reika web` (#584): one controller, the bridge and the local server in front of it. Ink-free, so
// cli.tsx can load it without React.

export type WebArgs = { port: number; help: boolean };

export const WEB_USAGE = `usage: reika web [--port <n>]   serve the agent to a browser tab on this machine (experimental)

  --port <n>    listen on this port (default: a free one)
  -h, --help    show this

Prints a link that works once and for ten minutes; open it in a browser. Press Enter for a new
link (a second tab, or after it expires). ctrl-c stops the server.`;

// Null unless the first word is `web`, so every other command line falls through to the TUI and
// headless parsers. Throws on what it does not know, as parseHeadlessArgs does.
export function parseWebArgs(argv: string[]): WebArgs | null {
  if (argv[0] !== 'web') return null;
  const args: WebArgs = { port: 0, help: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || !(n >= 1 && n <= 65535)) {
        throw new Error(`--port needs a whole number from 1 to 65535\n${WEB_USAGE}`);
      }
      args.port = n;
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
};

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

  const bridge = createWebBridge(controller, { onExit: () => void shutdown(0) });

  // Tabs first, so nothing new arrives; then the turn, so its last rows are in the save; then the
  // session's own children.
  function shutdown(code = 0): Promise<void> {
    shutdownPromise ??= (async () => {
      try {
        await server?.close();
        bridge.close();
        if (controller.abort()) await waitUntilNotBusy(controller);
        await controller.saveNow();
        await session!.mcp.close();
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
    });
  } catch (e) {
    bridge.close();
    await session.mcp.close();
    io.stderr(`reika: could not listen on port ${args.port}: ${(e as Error).message}\n`);
    return 1;
  }

  io.stdout(
    [
      `reika web (experimental) — ${session.config.model} in ${session.bundle.cwd}`,
      '',
      `  ${server.url}`,
      '',
      'Only this machine can connect, and the link signs in one browser tab: it works once, within',
      'ten minutes. Press Enter for a new link. ctrl-c to stop.',
      '',
    ].join('\n'),
  );

  const listening = server;
  return {
    url: server.url,
    port: server.port,
    newLink: () => listening.newLink(),
    shutdown,
    done,
  };
}
