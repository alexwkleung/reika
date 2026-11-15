import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `reika web --window` (#584): the page in an app window of a Chromium browser (no tabs, no
// address bar), or a tab in the default browser when there is none. The window's lifetime is the
// server's: closing it stops reika.

export type AppBrowser = { name: string; path: string };

type Platform = NodeJS.Platform;

// What `--app` is known to work in. Arc and Firefox are left out: neither opens an app window.
function candidates(platform: Platform, env: NodeJS.ProcessEnv): AppBrowser[] {
  if (platform === 'darwin') {
    return [
      ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    ].map(([name, path]) => ({ name, path }));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (r): r is string => typeof r === 'string' && r !== '',
    );
    const apps: [string, string][] = [
      ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ];
    return apps.flatMap(([name, rel]) => roots.map(root => ({ name, path: `${root}\\${rel}` })));
  }
  return [
    ['Google Chrome', '/usr/bin/google-chrome'],
    ['Microsoft Edge', '/usr/bin/microsoft-edge'],
    ['Brave', '/usr/bin/brave-browser'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Chromium', '/snap/bin/chromium'],
  ].map(([name, path]) => ({ name, path }));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// REIKA_CHROME_PATH first, as the search browser reads it.
export function findAppBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = osPlatform(),
  executable: (path: string) => boolean = isExecutable,
): AppBrowser | undefined {
  const override = env.REIKA_CHROME_PATH?.trim();
  if (override) return { name: 'the REIKA_CHROME_PATH browser', path: override };
  return candidates(platform, env).find(c => executable(c.path));
}

export const WINDOW_PROFILES_DIR = join(homedir(), '.config', 'reika', 'window');
const MAX_PROFILE_SLOTS = 16;
const LOCK_FILE = 'reika.lock';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, someone else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ProfileSlot = { dir: string; release: () => Promise<void> };

// Chromium's own lock on a profile, while a browser runs on it: a symlink to `<host>-<pid>` on
// macOS and Linux. A reika that crashed leaves its browser running here with a stale reika lock,
// and launching on it would hand the window to that browser and read as an early exit.
async function browserHolds(dir: string, alive: (pid: number) => boolean): Promise<boolean> {
  try {
    const target = await readlink(join(dir, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    return Number.isInteger(pid) && pid > 0 && alive(pid);
  } catch {
    return false;
  }
}

async function readHolder(lock: string): Promise<number | null> {
  const pid = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// A browser lets one process use a profile at a time; a second launch on a profile in use hands
// the window to the running copy and exits at once, which would read as the window closing. So
// each window takes the first slot no live reika and no live browser holds. One window, the usual
// case, keeps slot 0 and with it whatever the page remembers.
export async function claimProfileSlot(
  root = WINDOW_PROFILES_DIR,
  pid = process.pid,
  alive: (pid: number) => boolean = processAlive,
): Promise<ProfileSlot> {
  for (let n = 0; n < MAX_PROFILE_SLOTS; n++) {
    const dir = join(root, String(n));
    const lock = join(dir, LOCK_FILE);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await browserHolds(dir, alive)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lock, String(pid), { flag: 'wx', mode: 0o600 });
        return { dir, release: () => unlink(lock).catch(() => {}) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = await readHolder(lock);
      if (holder !== null && alive(holder)) break;
      // A stale lock is moved aside under a name only this reika uses, then checked: two reikas
      // that both read it stale must not both take the slot, and the second one moves aside the
      // first one's fresh lock, finds a different pid in it, and puts it back.
      const aside = `${lock}.${pid}.${randomBytes(3).toString('hex')}`;
      try {
        await rename(lock, aside);
      } catch {
        continue;
      }
      if ((await readHolder(aside)) !== holder) {
        await rename(aside, lock).catch(() => {});
        break;
      }
      await unlink(aside).catch(() => {});
    }
  }
  throw new Error(`every window profile under ${root} is in use`);
}

// The sign-in link never goes on a command line, where `ps` shows it to every user on the machine
// until the window has spent its code. The browser is pointed at this file instead, in a private
// directory, and it sends the page on.
export async function writeRedirectFile(
  link: string,
): Promise<{ url: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'reika-window-'));
  const file = join(dir, 'open.html');
  const target = JSON.stringify(link).replace(/</g, '\\u003c');
  await writeFile(
    file,
    [
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<meta name="referrer" content="no-referrer">',
      '<title>reika</title>',
      `<script>location.replace(${target})</script>`,
    ].join('\n'),
    { mode: 0o600 },
  );
  return {
    url: pathToFileURL(file).href,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

// A window that exits this soon did not open: a browser that refused the flags, or one that
// handed the window to a copy already running. Not a user closing it.
export const EARLY_EXIT_MS = 3000;

export type WindowOutcome = 'closed' | 'failed';

// `codeSpent` is told the window signed in: the redirect file is only a spent code from then on.
export type OpenedWindow =
  | {
      kind: 'app';
      browser: string;
      // 'closed' once the user closes it, 'failed' if it exits within EARLY_EXIT_MS.
      ended: Promise<WindowOutcome>;
      codeSpent: () => Promise<void>;
      close: () => Promise<void>;
    }
  | { kind: 'tab'; reason: string; codeSpent: () => Promise<void>; close: () => Promise<void> };

export type WindowDeps = {
  findBrowser?: () => AppBrowser | undefined;
  claimSlot?: () => Promise<ProfileSlot>;
  spawnBrowser?: (path: string, args: string[]) => ChildProcess;
  openDefault?: (url: string) => void;
  now?: () => number;
  // How long a browser asked to close may take before it is killed.
  killAfterMs?: number;
};

function openInDefaultBrowser(url: string): void {
  const platform = osPlatform();
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

const STALE_REDIRECT_MS = 60 * 60_000;

// A reika killed outright never removes its redirect dir; the next window sweeps what is an hour
// old. Fire and forget, and never an error.
export async function sweepStaleRedirects(dir = tmpdir(), now = Date.now()): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (!/^reika-window-[A-Za-z0-9]{6}$/.test(name)) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory() && now - info.mtimeMs > STALE_REDIRECT_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}

export async function openWindow(link: string, deps: WindowDeps = {}): Promise<OpenedWindow> {
  void sweepStaleRedirects();
  const redirect = await writeRedirectFile(link);
  // Removed once the code is spent; past a minute it is only a dead code on disk either way.
  const sweep = setTimeout(() => void redirect.remove(), 60_000);
  sweep.unref();
  const codeSpent = async (): Promise<void> => {
    clearTimeout(sweep);
    await redirect.remove();
  };
  const browser = (deps.findBrowser ?? findAppBrowser)();
  if (!browser) {
    (deps.openDefault ?? openInDefaultBrowser)(redirect.url);
    return {
      kind: 'tab',
      reason: 'no Chrome, Edge, Brave or Chromium found for an app window',
      codeSpent,
      close: codeSpent,
    };
  }
  const slot = await (deps.claimSlot ?? (() => claimProfileSlot()))();
  const now = deps.now ?? Date.now;
  const started = now();
  const child = (deps.spawnBrowser ?? ((path, args) => spawn(path, args, { stdio: 'ignore' })))(
    browser.path,
    [
      `--app=${redirect.url}`,
      `--user-data-dir=${slot.dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,860',
    ],
  );
  let closing = false;
  const running = () => child.exitCode === null && child.signalCode === null;
  const ended = new Promise<WindowOutcome>(resolve => {
    const finish = () => {
      void slot.release();
      resolve(!closing && now() - started < EARLY_EXIT_MS ? 'failed' : 'closed');
    };
    child.once('exit', finish);
    child.once('error', finish);
  });
  const waitFor = (ms: number) =>
    Promise.race([ended, new Promise(r => setTimeout(r, ms).unref())]);
  return {
    kind: 'app',
    browser: browser.name,
    ended,
    codeSpent,
    close: async () => {
      closing = true;
      // Asked first, so it can write its profile; killed if it has not gone by then, since the
      // slot is released for the next window either way.
      if (running()) child.kill('SIGTERM');
      await waitFor(deps.killAfterMs ?? 2000);
      if (running()) {
        child.kill('SIGKILL');
        await waitFor(1000);
      }
      await slot.release();
      await codeSpent();
    },
  };
}
