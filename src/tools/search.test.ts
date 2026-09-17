import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchTool, parseSearchQuery, resetSavedSearches } from './search.js';
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

beforeEach(resetSavedSearches);

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

describe('search tool — saved results (#297)', () => {
  it('serves a repeat of the same query from the session without a provider call or budget', async () => {
    const provider = makeProvider();
    const tool = createSearchTool(provider);
    const budget = makeBudget();
    const first = await tool.run(
      { query: 'vitest mock timers' },
      { cwd: '/tmp', webBudget: budget },
    );
    const again = await tool.run(
      { query: ' vitest mock timers ' },
      { cwd: '/tmp', webBudget: budget },
    );
    expect(provider.search).toHaveBeenCalledOnce();
    expect(budget.searches.used).toBe(1);
    expect(again.payload).toBe(first.payload);
    expect(again.summary).toBe(
      'Found 2 result(s) for "vitest mock timers" — already searched this session, served from the saved results',
    );
  });

  it('serves the repeat ahead of an exhausted budget and a latched provider failure', async () => {
    const provider = makeProvider();
    const tool = createSearchTool(provider);
    const budget = makeBudget(1);
    await tool.run({ query: 'q' }, { cwd: '/tmp', webBudget: budget });
    const out = await tool.run(
      { query: 'q' },
      { cwd: '/tmp', webBudget: budget, webHealth: { unavailable: 'no browser' } },
    );
    expect(out.summary).toMatch(/^Found 2 result\(s\) for "q" — already searched/);
    expect(provider.search).toHaveBeenCalledOnce();
  });

  it('does not save a search that found nothing, or one that failed', async () => {
    const empty: SearchProvider = { search: vi.fn().mockResolvedValue([]) };
    const tool = createSearchTool(empty);
    await tool.run({ query: 'nothing' }, { cwd: '/tmp' });
    await tool.run({ query: 'nothing' }, { cwd: '/tmp' });
    expect(empty.search).toHaveBeenCalledTimes(2);

    const failing: SearchProvider = { search: vi.fn().mockRejectedValue(new Error('boom')) };
    const tool2 = createSearchTool(failing);
    await tool2.run({ query: 'broken' }, { cwd: '/tmp' });
    await tool2.run({ query: 'broken' }, { cwd: '/tmp' });
    expect(failing.search).toHaveBeenCalledTimes(2);
  });

  it('quotes the query verbatim in the summary, which is all an aged result keeps', async () => {
    const tool = createSearchTool(makeProvider());
    const query = 'node "fs.watch" recursive macos';
    const out = await tool.run({ query }, { cwd: '/tmp' });
    expect(out.summary).toBe(`Found 2 result(s) for "${query}"`);
    expect(parseSearchQuery(out.summary)).toBe(query);
  });

  it('parseSearchQuery reads fresh and served summaries and rejects the rest', () => {
    expect(parseSearchQuery('Found 8 result(s) for "a b"')).toBe('a b');
    expect(
      parseSearchQuery(
        'Found 3 result(s) for "a b" — already searched this session, served from the saved results',
      ),
    ).toBe('a b');
    expect(parseSearchQuery('No results for "a b"')).toBeNull();
    expect(parseSearchQuery('Search failed: boom')).toBeNull();
    expect(parseSearchQuery('Search budget exceeded for this turn (max 3). Summarize')).toBeNull();
    expect(parseSearchQuery('Search still unavailable this turn: no browser')).toBeNull();
  });
});
