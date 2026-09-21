import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractUrl, fetchUrlTool, resetSavedPages } from './fetch.js';
import type { ToolContext, WebBudget, WebHealth } from '../types.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  resetSavedPages();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const mock = () => globalThis.fetch as ReturnType<typeof vi.fn>;

// undici's shape for a socket failure: the text that reaches `message` is "fetch failed", the
// real error is on `cause`.
function undiciError(code: string, message: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

function ctxWith(max = 5): ToolContext & { webBudget: WebBudget; webHealth: WebHealth } {
  return {
    cwd: '/tmp',
    webBudget: { searches: { used: 0, max: 3 }, fetches: { used: 0, max } },
    webHealth: {},
  } as ToolContext & { webBudget: WebBudget; webHealth: WebHealth };
}

describe('extractUrl — failure text names the cause', () => {
  it('reports the root message and code, not undici\'s outer "fetch failed"', async () => {
    mock().mockRejectedValue(undiciError('ENOTFOUND', 'getaddrinfo ENOTFOUND host.example'));
    const result = await extractUrl('https://host.example/');
    expect(result).toEqual({
      ok: false,
      reached: false,
      error: 'getaddrinfo ENOTFOUND host.example',
      code: 'ENOTFOUND',
    });
  });

  it('omits `code` for an error that has none', async () => {
    mock().mockRejectedValue(new Error('boom'));
    expect(await extractUrl('https://host.example/')).toEqual({
      ok: false,
      reached: false,
      error: 'boom',
    });
  });
});

// #392: a fetch that finds the network down latches the turn. Every further web call would fail
// the same way, and on a local model each one is a round of prefill + decode for nothing.
describe('fetch_url tool — offline latch', () => {
  it('latches the turn on a network-down code, refunds the call, and warns the user once', async () => {
    mock().mockRejectedValue(undiciError('ENOTFOUND', 'getaddrinfo ENOTFOUND a.example'));
    const ctx = ctxWith();
    const first = await fetchUrlTool.run({ url: 'https://a.example/' }, ctx);
    expect(first.summary).toMatch(
      /^Fetch failed: https:\/\/a\.example\/ \(getaddrinfo ENOTFOUND a\.example\) — the network is unreachable/,
    );
    expect(first.notice).toEqual({
      tone: 'warn',
      content: expect.stringMatching(/Network unreachable \(ENOTFOUND\)/),
    });
    expect(ctx.webHealth.offline).toBe('ENOTFOUND');
    expect(ctx.webBudget.fetches.used).toBe(0);

    const second = await fetchUrlTool.run({ url: 'https://b.example/' }, ctx);
    expect(second.summary).toBe('Fetch skipped: still offline this turn (ENOTFOUND)');
    expect(second.notice).toBeUndefined();
    expect(mock()).toHaveBeenCalledTimes(1);
    expect(ctx.webBudget.fetches.used).toBe(0);
  });

  it('keeps a host-specific failure per-call: charged, not latched', async () => {
    mock().mockRejectedValue(undiciError('ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:443'));
    const ctx = ctxWith();
    const out = await fetchUrlTool.run({ url: 'https://a.example/' }, ctx);
    expect(out.summary).toBe(
      'Fetch failed: https://a.example/ (connect ECONNREFUSED 93.184.216.34:443)',
    );
    expect(out.notice).toBeUndefined();
    expect(ctx.webHealth.offline).toBeUndefined();
    expect(ctx.webBudget.fetches.used).toBe(1);
    await fetchUrlTool.run({ url: 'https://b.example/' }, ctx);
    expect(mock()).toHaveBeenCalledTimes(2);
  });

  it('does not latch on a server error, a timeout, or a host-policy block', async () => {
    const ctx = ctxWith();
    mock().mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await fetchUrlTool.run({ url: 'https://a.example/' }, ctx);
    mock().mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await fetchUrlTool.run({ url: 'https://b.example/' }, ctx);
    await fetchUrlTool.run({ url: 'http://127.0.0.1:8080/' }, ctx);
    expect(ctx.webHealth.offline).toBeUndefined();
  });

  it('works with no webHealth on the context at all', async () => {
    mock().mockRejectedValue(undiciError('ENETUNREACH', 'connect ENETUNREACH'));
    const out = await fetchUrlTool.run({ url: 'https://a.example/' }, {
      cwd: '/tmp',
    } as ToolContext);
    expect(out.summary).toMatch(/network is unreachable/);
  });
});
