import { beforeEach, describe, expect, it } from 'vitest';
import { createSearchTool, resetSavedSearches } from './search.js';
import { SearchUnavailableError } from '../search/types.js';
import type { SearchProvider, SearchResult } from '../search/types.js';
import type { WebHealth, ToolContext, WebBudget } from '../types.js';

function ctxWith(max = 3): ToolContext & { webBudget: WebBudget; webHealth: WebHealth } {
  return {
    cwd: '/tmp',
    webBudget: { searches: { used: 0, max }, fetches: { used: 0, max: 5 } },
    webHealth: {},
  } as ToolContext & { webBudget: WebBudget; webHealth: WebHealth };
}

const failing = (err: Error): SearchProvider => ({
  async search(): Promise<SearchResult[]> {
    throw err;
  },
});

let calls = 0;
const counting = (err: Error): SearchProvider => ({
  async search(): Promise<SearchResult[]> {
    calls++;
    throw err;
  },
});

const unavailable = () =>
  new SearchUnavailableError(
    'every SearXNG engine was unavailable (duckduckgo: CAPTCHA)',
    'Try REIKA_CDP_SEARCH=1.',
  );

beforeEach(resetSavedSearches);

describe('search tool — provider-level failure latch', () => {
  it('reports the failure and latches it on the turn', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool(failing(unavailable()));
    const out = await tool.run({ query: 'a' }, ctx);
    expect(out.summary).toMatch(/Search failed: every SearXNG engine was unavailable/);
    expect(ctx.webHealth.unavailable).toMatch(/every SearXNG engine/);
  });

  it('does not re-attempt the provider once latched', async () => {
    calls = 0;
    const ctx = ctxWith();
    const tool = createSearchTool(counting(unavailable()));
    await tool.run({ query: 'a' }, ctx);
    await tool.run({ query: 'b reworded' }, ctx);
    await tool.run({ query: 'c reworded again' }, ctx);
    expect(calls).toBe(1);
  });

  it('words a latched call as still-blocked, not as a fresh problem', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool(failing(unavailable()));
    await tool.run({ query: 'a' }, ctx);
    const second = await tool.run({ query: 'b' }, ctx);
    expect(second.summary).toMatch(/^Search still unavailable this turn:/);
  });

  // The cap exists to stop runaway loops hammering upstream engines. A search that never got an
  // answer isn't that egress, so three refused searches must not consume a three-search turn.
  it('spends no budget on a refused search', async () => {
    const ctx = ctxWith(3);
    const tool = createSearchTool(failing(unavailable()));
    await tool.run({ query: 'a' }, ctx);
    await tool.run({ query: 'b' }, ctx);
    await tool.run({ query: 'c' }, ctx);
    expect(ctx.webBudget.searches.used).toBe(0);
  });

  it('surfaces the remedy to the user once, not on every latched call', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool(failing(unavailable()));
    const first = await tool.run({ query: 'a' }, ctx);
    const second = await tool.run({ query: 'b' }, ctx);
    expect(first.notice).toEqual({ tone: 'warn', content: 'Try REIKA_CDP_SEARCH=1.' });
    expect(second.notice).toBeUndefined();
  });

  it('omits the notice when the failure carries no remedy', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool(failing(new SearchUnavailableError('no result list')));
    expect((await tool.run({ query: 'a' }, ctx)).notice).toBeUndefined();
  });
});

describe('search tool — query-level failures stay query-level', () => {
  it('does not latch an ordinary error, and still charges for it', async () => {
    calls = 0;
    const ctx = ctxWith();
    const tool = createSearchTool(counting(new Error('could not parse results from the page')));
    await tool.run({ query: 'a' }, ctx);
    await tool.run({ query: 'b' }, ctx);
    expect(calls).toBe(2);
    expect(ctx.webHealth.unavailable).toBeUndefined();
    expect(ctx.webBudget.searches.used).toBe(2);
  });

  it('still enforces the budget for searches that actually ran', async () => {
    const ctx = ctxWith(1);
    const tool = createSearchTool({
      async search() {
        return [{ title: 'T', url: 'https://e.example', snippet: '' }];
      },
    });
    await tool.run({ query: 'a' }, ctx);
    const second = await tool.run({ query: 'b' }, ctx);
    expect(second.summary).toMatch(/budget exceeded/i);
  });

  it('works with no webHealth on the context at all', async () => {
    const tool = createSearchTool(failing(unavailable()));
    const out = await tool.run({ query: 'a' }, { cwd: '/tmp' } as ToolContext);
    expect(out.summary).toMatch(/Search failed:/);
  });
});

// #238: a bot check the provider raised for the user. The provider reports the two moments; the
// tool decides what the user sees — a live line while the window is up, a persistent receipt after.
describe('search tool — bot check raised for the user', () => {
  const challenged = (results: SearchResult[]): SearchProvider => ({
    async search(_q, opts): Promise<SearchResult[]> {
      opts?.onChallenge?.('raised');
      opts?.onChallenge?.('cleared');
      return results;
    },
  });

  it('narrates the raised window on the live tool line and records the solve as a receipt', async () => {
    const progress: string[] = [];
    const ctx = { ...ctxWith(), onProgress: (c: string) => progress.push(c) };
    const tool = createSearchTool(
      challenged([{ title: 'T', url: 'https://x.example/a', snippet: '' }]),
    );
    const out = await tool.run({ query: 'a' }, ctx);
    expect(progress.join('')).toMatch(/bot check.*browser window/i);
    expect(out.summary).toMatch(/Found 1 result/);
    expect(out.notice).toEqual({
      tone: 'info',
      content: expect.stringMatching(/Bot check completed/),
    });
    // The search answered, so the budget was spent once and nothing latched.
    expect(ctx.webBudget.searches.used).toBe(1);
    expect(ctx.webHealth.unavailable).toBeUndefined();
  });

  it('keeps the receipt on a solve that then found nothing', async () => {
    const tool = createSearchTool(challenged([]));
    const out = await tool.run({ query: 'a' }, ctxWith());
    expect(out.summary).toMatch(/No results/);
    expect(out.notice?.tone).toBe('info');
  });

  it('emits no receipt when no check was raised', async () => {
    const plain: SearchProvider = {
      async search(): Promise<SearchResult[]> {
        return [{ title: 'T', url: 'https://x.example/a', snippet: '' }];
      },
    };
    const out = await createSearchTool(plain).run({ query: 'a' }, ctxWith());
    expect(out.notice).toBeUndefined();
  });
});

// #392: the network going down is found by a fetch, but it blocks searches just the same.
describe('search tool — offline latch set by fetch_url', () => {
  it('skips the provider without spending budget once the turn is offline', async () => {
    calls = 0;
    const ctx = ctxWith();
    ctx.webHealth.offline = 'ENOTFOUND';
    const tool = createSearchTool(counting(new Error('should not run')));
    const out = await tool.run({ query: 'a' }, ctx);
    expect(out.summary).toBe('Search skipped: still offline this turn (ENOTFOUND)');
    expect(calls).toBe(0);
    expect(ctx.webBudget.searches.used).toBe(0);
  });

  it('still serves a query already saved this session — no network needed', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool({
      async search() {
        return [{ title: 'T', url: 'https://x.example/a', snippet: '' }];
      },
    });
    await tool.run({ query: 'a' }, ctx);
    ctx.webHealth.offline = 'ENOTFOUND';
    const again = await tool.run({ query: 'a' }, ctx);
    expect(again.summary).toMatch(/served from the saved results/);
  });
});
