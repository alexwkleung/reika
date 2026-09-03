import { describe, expect, it } from 'vitest';
import { createSearchTool } from './search.js';
import { SearchUnavailableError } from '../search/types.js';
import type { SearchProvider, SearchResult } from '../search/types.js';
import type { SearchHealth, ToolContext, WebBudget } from '../types.js';

function ctxWith(max = 3): ToolContext & { webBudget: WebBudget; searchHealth: SearchHealth } {
  return {
    cwd: '/tmp',
    webBudget: { searches: { used: 0, max }, fetches: { used: 0, max: 5 } },
    searchHealth: {},
  } as ToolContext & { webBudget: WebBudget; searchHealth: SearchHealth };
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

describe('search tool — provider-level failure latch', () => {
  it('reports the failure and latches it on the turn', async () => {
    const ctx = ctxWith();
    const tool = createSearchTool(failing(unavailable()));
    const out = await tool.run({ query: 'a' }, ctx);
    expect(out.summary).toMatch(/Search failed: every SearXNG engine was unavailable/);
    expect(ctx.searchHealth.unavailable).toMatch(/every SearXNG engine/);
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
    expect(ctx.searchHealth.unavailable).toBeUndefined();
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

  it('works with no searchHealth on the context at all', async () => {
    const tool = createSearchTool(failing(unavailable()));
    const out = await tool.run({ query: 'a' }, { cwd: '/tmp' } as ToolContext);
    expect(out.summary).toMatch(/Search failed:/);
  });
});
