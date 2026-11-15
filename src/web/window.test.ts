import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimProfileSlot,
  EARLY_EXIT_MS,
  findAppBrowser,
  openWindow,
  writeRedirectFile,
} from './window.js';

const link = 'http://127.0.0.1:4321/#code=SECRET_CODE';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reika-window-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findAppBrowser', () => {
  it('takes REIKA_CHROME_PATH first', () => {
    expect(findAppBrowser({ REIKA_CHROME_PATH: ' /opt/c ' }, 'darwin', () => false)).toEqual({
      name: 'the REIKA_CHROME_PATH browser',
      path: '/opt/c',
    });
  });

  it('tries Chrome, Edge, Brave, then Chromium', () => {
    const found = (present: string[]) =>
      findAppBrowser({}, 'darwin', p => present.some(x => p.includes(x)))?.name;
    expect(found(['Chromium', 'Brave', 'Edge', 'Google Chrome'])).toBe('Google Chrome');
    expect(found(['Chromium', 'Brave', 'Edge'])).toBe('Microsoft Edge');
    expect(found(['Chromium', 'Brave'])).toBe('Brave');
    expect(found(['Chromium'])).toBe('Chromium');
    expect(found([])).toBeUndefined();
  });

  it('looks under Program Files on Windows', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files' };
    expect(
      findAppBrowser(
        env,
        'win32',
        p => p === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ),
    ).toEqual({
      name: 'Microsoft Edge',
      path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    });
  });
});

describe('claimProfileSlot', () => {
  it('takes slot 0, and the next while a live reika holds it', async () => {
    const alive = (pid: number) => pid === 111;
    const first = await claimProfileSlot(root, 111, alive);
    expect(first.dir).toBe(join(root, '0'));
    const second = await claimProfileSlot(root, 222, alive);
    expect(second.dir).toBe(join(root, '1'));
    await first.release();
    expect((await claimProfileSlot(root, 333, alive)).dir).toBe(join(root, '0'));
  });

  it('takes over a slot whose reika has died', async () => {
    await claimProfileSlot(root, 111, () => true);
    const next = await claimProfileSlot(root, 222, () => false);
    expect(next.dir).toBe(join(root, '0'));
    expect(await readFile(join(root, '0', 'reika.lock'), 'utf8')).toBe('222');
  });

  it('takes over a lock that holds no pid', async () => {
    await claimProfileSlot(root, 111, () => true);
    await writeFile(join(root, '0', 'reika.lock'), 'junk');
    expect((await claimProfileSlot(root, 222, () => true)).dir).toBe(join(root, '0'));
  });

  it('gives up when every slot is held', async () => {
    for (let i = 0; i < 16; i++) await claimProfileSlot(root, 1000 + i, () => true);
    await expect(claimProfileSlot(root, 9999, () => true)).rejects.toThrow(/every window profile/);
  });
});

describe('writeRedirectFile', () => {
  it('writes a private page that sends the browser on, and removes it', async () => {
    const r = await writeRedirectFile(link);
    expect(r.url).toMatch(/^file:\/\//);
    expect(r.url).not.toContain('SECRET_CODE');
    const file = fileURLToPath(r.url);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).toContain(`location.replace(${JSON.stringify(link)})`);
    await r.remove();
    await expect(stat(dirname(file))).rejects.toThrow();
  });

  it('cannot be closed out of its script by the link', async () => {
    const r = await writeRedirectFile('http://127.0.0.1:1/#code=</script><script>x()');
    const html = await readFile(fileURLToPath(r.url), 'utf8');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    await r.remove();
  });
});

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    }),
  });
  return child;
}

describe('openWindow', () => {
  const setup = (opts: { browser?: boolean } = {}) => {
    let clock = 0;
    const child = fakeChild();
    const spawned: string[][] = [];
    const released = vi.fn(async () => {});
    const openedDefault: string[] = [];
    const deps = {
      findBrowser: () =>
        opts.browser === false ? undefined : { name: 'Chromium', path: '/bin/c' },
      claimSlot: async () => ({ dir: join(root, '0'), release: released }),
      spawnBrowser: (_path: string, args: string[]) => {
        spawned.push(args);
        return child;
      },
      openDefault: (url: string) => void openedDefault.push(url),
      now: () => clock,
    };
    return { child, spawned, released, openedDefault, deps, tick: (ms: number) => (clock += ms) };
  };

  it('launches an app window on the redirect file, never the link', async () => {
    const t = setup();
    const win = await openWindow(link, t.deps);
    expect(win.kind).toBe('app');
    const args = t.spawned[0];
    expect(args.join(' ')).not.toContain('SECRET_CODE');
    expect(args[0]).toMatch(/^--app=file:\/\//);
    expect(args).toContain(`--user-data-dir=${join(root, '0')}`);
    await win.close();
  });

  it('reads an exit right after launch as a failure, and a later one as closed', async () => {
    const early = setup();
    const a = await openWindow(link, early.deps);
    early.tick(EARLY_EXIT_MS - 1);
    early.child.emit('exit', 0, null);
    expect(a.kind === 'app' && (await a.ended)).toBe('failed');
    expect(early.released).toHaveBeenCalled();

    const late = setup();
    const b = await openWindow(link, late.deps);
    late.tick(EARLY_EXIT_MS + 1);
    late.child.emit('exit', 0, null);
    expect(b.kind === 'app' && (await b.ended)).toBe('closed');
  });

  it('kills the window on close, which reads as closed however soon', async () => {
    const t = setup();
    const win = await openWindow(link, t.deps);
    await win.close();
    expect(t.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(win.kind === 'app' && (await win.ended)).toBe('closed');
    expect(t.released).toHaveBeenCalled();
    const file = fileURLToPath(t.spawned[0][0].slice('--app='.length));
    await expect(stat(file)).rejects.toThrow();
  });

  it('opens a tab in the default browser when there is no app browser', async () => {
    const t = setup({ browser: false });
    const win = await openWindow(link, t.deps);
    expect(win).toMatchObject({ kind: 'tab', reason: expect.stringMatching(/no Chrome/) });
    expect(t.openedDefault).toHaveLength(1);
    expect(t.openedDefault[0]).not.toContain('SECRET_CODE');
    await win.close();
    await expect(stat(fileURLToPath(t.openedDefault[0]))).rejects.toThrow();
  });
});
