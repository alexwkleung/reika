import type { SearchProvider } from '../search/types.js';
import type { Tool } from '../types.js';

export function createSearchTool(provider: SearchProvider): Tool {
  return {
    name: 'search',
    description:
      'Search the web. Returns up to 8 results with title, URL, and a short snippet. Use only when the task requires current information or external documentation not present in repo files. Call fetch_url on a specific result to read it in full.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) return { summary: 'Search failed: empty query' };
      const budget = ctx.webBudget?.searches;
      if (budget && budget.used >= budget.max) {
        return {
          summary: `Search budget exceeded for this turn (max ${budget.max}). Summarize what you have or split into multiple turns.`,
        };
      }
      if (budget) budget.used++;
      try {
        const raw = await provider.search(query, { maxResults: 8 });
        // Filter out results missing a URL — those are unusable for the model
        // (it can't cite or fetch them) and lead to "undefined" leaking into
        // citations downstream.
        const results = raw.filter(r => r.url && r.url.trim().length > 0);
        if (results.length === 0) {
          return { summary: `No results for "${query}"` };
        }
        const payload = results
          .map((r, i) => `${i + 1}. ${r.title || '(no title)'}\n   ${r.url}\n   ${r.snippet || ''}`)
          .join('\n\n');
        return {
          summary: `Found ${results.length} result(s) for "${query}"`,
          payload,
        };
      } catch (e) {
        return { summary: `Search failed: ${(e as Error).message}` };
      }
    },
  };
}
