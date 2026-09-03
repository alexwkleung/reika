import { SearchUnavailableError } from '../search/types.js';
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

      // A provider-level failure already reported this turn: no browser, a bot check, every engine
      // refused. Re-attempting cannot succeed, so say so without spending a call or the budget —
      // the model was going to reword and try again otherwise, which is what burns a 3-search turn
      // on one condition. Worded as still-blocked rather than a fresh problem for the same reason.
      const latched = ctx.searchHealth?.unavailable;
      if (latched) {
        return { summary: `Search still unavailable this turn: ${latched}` };
      }

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
        if (e instanceof SearchUnavailableError) {
          // Latch for the rest of the turn, and refund the call. The cap exists to stop runaway
          // loops hammering upstream engines (AGENTS.md); a search that never got an answer — a
          // missing browser reaches nothing at all — is not the egress it was built to limit.
          if (ctx.searchHealth) ctx.searchHealth.unavailable = e.message;
          if (budget) budget.used--;
          return {
            summary: `Search failed: ${e.message}`,
            // The remedy is for the user, not the model: it cannot set an environment variable, and
            // naming one in its context is noise it can only ignore. Emitted once — on the failure
            // that sets the latch — so a turn with three searches doesn't print three identical
            // warnings.
            ...(e.remedy ? { notice: { tone: 'warn' as const, content: e.remedy } } : {}),
          };
        }
        return { summary: `Search failed: ${(e as Error).message}` };
      }
    },
  };
}
