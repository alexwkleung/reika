import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  centredPosition,
  claimProfileSlot,
  EARLY_EXIT_MS,
  findAppBrowser,
  fittedSize,
  openWindow,
  type ScreenArea,
  sweepStaleRedirects,
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

  it('skips a slot a live browser still holds, as a crashed reika leaves it', async () => {
    await mkdir(join(root, '0'), { recursive: true });
    await writeFile(join(root, '0', 'reika.lock'), '111');
    await symlink('host-4242', join(root, '0', 'SingletonLock'));
    const alive = (pid: number) => pid === 4242;
    expect((await claimProfileSlot(root, 222, alive)).dir).toBe(join(root, '1'));
    // Once that browser is gone the slot is free again.
    expect((await claimProfileSlot(root, 333, () => false)).dir).toBe(join(root, '0'));
  });

  it('leaves no lock files aside after a takeover', async () => {
    await claimProfileSlot(root, 111, () => true);
    await claimProfileSlot(root, 222, () => false);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(root, '0'))).filter(n => n.startsWith('reika.lock'))).toEqual([
      'reika.lock',
    ]);
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

// `ignores` lists the signals it outlives, as a browser busy writing its profile might.
function fakeChild(ignores: string[] = []) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      if (ignores.includes(signal)) return true;
      queueMicrotask(() => {
        Object.assign(child, { signalCode: signal });
        child.emit('exit', null, signal);
      });
      return true;
    }),
  });
  return child;
}

describe('openWindow', () => {
  const setup = (opts: { browser?: boolean; ignores?: string[]; area?: ScreenArea } = {}) => {
    let clock = 0;
    const child = fakeChild(opts.ignores);
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
      screenArea: async () => opts.area,
      now: () => clock,
      killAfterMs: 20,
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

  it('centres the window on the screen area, and leaves placement alone without one', async () => {
    const t = setup({ area: { x: 0, y: 30, width: 2560, height: 1410 } });
    const win = await openWindow(link, t.deps);
    expect(t.spawned[0]).toContain('--window-size=1280,960');
    expect(t.spawned[0]).toContain('--window-position=640,255');
    await win.close();

    const bare = setup();
    const w2 = await openWindow(link, bare.deps);
    expect(bare.spawned[0].some(a => a.startsWith('--window-position'))).toBe(false);
    await w2.close();
  });

  it('shrinks the window to a screen shorter than it, and centres what is left', async () => {
    const t = setup({ area: { x: 0, y: 37, width: 1470, height: 856 } });
    const win = await openWindow(link, t.deps);
    expect(t.spawned[0]).toContain('--window-size=1280,856');
    expect(t.spawned[0]).toContain('--window-position=95,37');
    await win.close();
    expect(fittedSize(undefined)).toEqual({ width: 1280, height: 960 });
  });

  it('keeps the top-left on a screen smaller than the window', () => {
    expect(centredPosition({ x: -1024, y: 0, width: 1024, height: 768 })).toEqual({
      x: -1024,
      y: 0,
    });
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

  it('kills a browser that outlives the close', async () => {
    const t = setup({ ignores: ['SIGTERM'] });
    const win = await openWindow(link, t.deps);
    await win.close();
    expect(t.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(t.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(win.kind === 'app' && (await win.ended)).toBe('closed');
  });

  it('removes the redirect file once the code is spent', async () => {
    const t = setup();
    const win = await openWindow(link, t.deps);
    const file = fileURLToPath(t.spawned[0][0].slice('--app='.length));
    await stat(file);
    await win.codeSpent();
    await expect(stat(file)).rejects.toThrow();
    await win.close();
  });
});

describe('sweepStaleRedirects', () => {
  it('removes redirect dirs an hour old, and nothing else', async () => {
    const old = join(root, 'reika-window-AbC123');
    const fresh = join(root, 'reika-window-XyZ789');
    const other = join(root, 'reika-abc123');
    for (const d of [old, fresh, other]) await mkdir(d);
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    await utimes(old, hourAgo, hourAgo);
    await utimes(other, hourAgo, hourAgo);
    await sweepStaleRedirects(root);
    await expect(stat(old)).rejects.toThrow();
    await stat(fresh);
    await stat(other);
  });
});
