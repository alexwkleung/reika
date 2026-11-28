import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './session.js';

const resolvePr = vi.hoisted(() => vi.fn());
vi.mock('./ui/pr.js', () => ({ resolvePr }));

const { createController } = await import('./controller.js');

const session = (cwd = '/repo/app', config: { prBadge?: boolean } = {}) =>
  ({
    bundle: { cwd },
    getSnapshot: () => ({ config }),
    subscribe: () => () => {},
  }) as unknown as Session;

const flush = () => new Promise(r => setTimeout(r, 0));

afterEach(() => {
  resolvePr.mockReset();
  vi.useRealTimers();
});

describe('the status bar PR', () => {
  it('is looked up for the session cwd once a session attaches, and polled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const pr = { number: 7, url: 'https://github.com/octocat/app/pull/7' };
    resolvePr.mockResolvedValue(pr);
    const c = createController({ mode: 'agent', remember: vi.fn(), pollPr: true });
    expect(c.getSnapshot().pr).toBeNull();
    c.attachSession(session(), 'default');
    await flush();
    expect(resolvePr).toHaveBeenCalledWith('/repo/app', expect.any(Number));
    expect(c.getSnapshot().pr).toBe(pr);
    resolvePr.mockResolvedValue({ number: 8, state: 'merged' });
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(c.getSnapshot().pr).toEqual({ number: 8, state: 'merged' });
  });

  it('notifies only when the PR changed', async () => {
    const pr = { number: 7 };
    resolvePr.mockResolvedValue(pr);
    const c = createController({ mode: 'agent', remember: vi.fn(), pollPr: true });
    c.attachSession(session(), 'default');
    await flush();
    const listener = vi.fn();
    c.subscribe(listener);
    vi.useFakeTimers({ toFake: ['setInterval'] });
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('never shells out with REIKA_PR_BADGE=0, timer ticks included', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const c = createController({ mode: 'agent', remember: vi.fn(), pollPr: true });
    c.attachSession(session('/repo/app', { prBadge: false }), 'default');
    await flush();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(resolvePr).not.toHaveBeenCalled();
    expect(c.getSnapshot().pr).toBeNull();
  });

  it('never shells out unless a front end asks', async () => {
    const c = createController({ mode: 'agent', remember: vi.fn() });
    c.attachSession(session(), 'default');
    await flush();
    expect(resolvePr).not.toHaveBeenCalled();
    expect(c.getSnapshot().pr).toBeNull();
  });
});
