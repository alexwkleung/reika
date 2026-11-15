import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

// A browser lets one process use a profile at a time; a second launch on a profile in use hands
// the window to the running copy and exits at once, which would read as the window closing. So
// each window takes the first slot no live reika holds. One window, the usual case, keeps slot 0
// and with it whatever the page remembers.
export async function claimProfileSlot(
  root = WINDOW_PROFILES_DIR,
  pid = process.pid,
  alive: (pid: number) => boolean = processAlive,
): Promise<ProfileSlot> {
  for (let n = 0; n < MAX_PROFILE_SLOTS; n++) {
    const dir = join(root, String(n));
    const lock = join(dir, LOCK_FILE);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lock, String(pid), { flag: 'wx', mode: 0o600 });
        return { dir, release: () => unlink(lock).catch(() => {}) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
        // A lock left by a reika that died is taken over; a live one moves us to the next slot.
        if (Number.isInteger(holder) && holder > 0 && alive(holder)) break;
        await unlink(lock).catch(() => {});
      }
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

export type OpenedWindow =
  | {
      kind: 'app';
      browser: string;
      // 'closed' once the user closes it, 'failed' if it exits within EARLY_EXIT_MS.
      ended: Promise<WindowOutcome>;
      close: () => Promise<void>;
    }
  | { kind: 'tab'; reason: string; close: () => Promise<void> };

export type WindowDeps = {
  findBrowser?: () => AppBrowser | undefined;
  claimSlot?: () => Promise<ProfileSlot>;
  spawnBrowser?: (path: string, args: string[]) => ChildProcess;
  openDefault?: (url: string) => void;
  now?: () => number;
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

export async function openWindow(link: string, deps: WindowDeps = {}): Promise<OpenedWindow> {
  const redirect = await writeRedirectFile(link);
  // The code is spent the moment the page loads, and a slow first start is a few seconds; past a
  // minute the file is only a dead code on disk.
  const sweep = setTimeout(() => void redirect.remove(), 60_000);
  sweep.unref();
  const browser = (deps.findBrowser ?? findAppBrowser)();
  if (!browser) {
    (deps.openDefault ?? openInDefaultBrowser)(redirect.url);
    return {
      kind: 'tab',
      reason: 'no Chrome, Edge, Brave or Chromium found for an app window',
      close: async () => {
        clearTimeout(sweep);
        await redirect.remove();
      },
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
  const ended = new Promise<WindowOutcome>(resolve => {
    const finish = () => {
      void slot.release();
      resolve(!closing && now() - started < EARLY_EXIT_MS ? 'failed' : 'closed');
    };
    child.once('exit', finish);
    child.once('error', finish);
  });
  return {
    kind: 'app',
    browser: browser.name,
    ended,
    close: async () => {
      closing = true;
      clearTimeout(sweep);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([ended, new Promise(r => setTimeout(r, 2000).unref())]);
      await slot.release();
      await redirect.remove();
    },
  };
}
