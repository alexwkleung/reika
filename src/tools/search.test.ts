import { describe, expect, it, vi } from 'vitest';
import { createSearchTool } from './search.js';
import type { SearchProvider } from '../search/types.js';
import type { WebBudget } from '../types.js';

function makeProvider(): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn().mockResolvedValue([
      { title: 'A', url: 'https://a.example', snippet: 's' },
      { title: 'B', url: 'https://b.example', snippet: 's' },
    ]),
  };
}

function makeBudget(searchesMax = 3, fetchesMax = 5): WebBudget {
  return {
    searches: { used: 0, max: searchesMax },
    fetches: { used: 0, max: fetchesMax },
  };
}

describe('search tool — budget enforcement', () => {
  it('calls provider and increments budget on each search', async () => {
    const provider = makeProvider();
    const tool = createSearchTool(provider);
    const budget = makeBudget();
    await tool.run({ query: 'hello' }, { cwd: '/tmp', webBudget: budget });
    expect(provider.search).toHaveBeenCalledOnce();
    expect(budget.searches.used).toBe(1);
  });

  it('blocks search when budget is exhausted', async () => {
    const provider = makeProvider();
    const tool = createSearchTool(provider);
    const budget = makeBudget(2);
    budget.searches.used = 2; // already at max
    const result = await tool.run({ query: 'x' }, { cwd: '/tmp', webBudget: budget });
    expect(result.summary).toMatch(/Search budget exceeded/);
    expect(provider.search).not.toHaveBeenCalled();
    expect(budget.searches.used).toBe(2); // unchanged
  });

  it('works without a budget (no enforcement)', async () => {
    const provider = makeProvider();
    const tool = createSearchTool(provider);
    const result = await tool.run({ query: 'x' }, { cwd: '/tmp' });
    expect(result.summary).toMatch(/Found 2 result/);
    expect(provider.search).toHaveBeenCalledOnce();
  });

  it('still counts toward budget when provider fails', async () => {
    const provider: SearchProvider = {
      search: vi.fn().mockRejectedValue(new Error('upstream timeout')),
    };
    const tool = createSearchTool(provider);
    const budget = makeBudget();
    const result = await tool.run({ query: 'x' }, { cwd: '/tmp', webBudget: budget });
    expect(result.summary).toMatch(/Search failed/);
    expect(budget.searches.used).toBe(1); // failed call still counts
  });
});
