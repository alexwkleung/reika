import { SearchUnavailableError } from '../search/types.js';
import type { SearchProvider } from '../search/types.js';
import type { Tool } from '../types.js';

// Results kept this session, by query (#297). A search payload ages out of the window like any
// other; what stays is its summary, which quotes the query verbatim — the cheapest handle there is
// on a result set, and the one a model actually reuses: it copies the string back into `search`.
// Serve that repeat from here rather than upstream. A search is a browser round trip (and a bot
// check risk) on the CDP provider and a spent slot of a 3-per-turn budget on all of them, and the
// model asking again wants what it had, not a fresh ranking. Keyed on the query as the model wrote
// it, trimmed, because that is what the summary shows and what gets copied. Not an eviction
// exemption: the result bytes leave the window on schedule (an exemption would shrink the pool
// every other payload ages in), and only the one-line query survives. ~2KB per entry, bounded by
// the turn budget times the session's turns.
const savedSearches = new Map<string, { payload: string; count: number }>();

// Reset between tests.
export function resetSavedSearches(): void {
  savedSearches.clear();
}

// The one summary shape for a search that found something, fresh or served from the saved set:
// `compaction.ts` reads the query back out of it for the recap's "Web searches run" line, so the
// quoted query must stay where it is and the cache note must stay after it.
function foundSummary(query: string, count: number, cached: boolean): string {
  const how = cached ? ' — already searched this session, served from the saved results' : '';
  return `Found ${count} result(s) for "${query}"${how}`;
}

// The query out of a `search` summary, for the recap. Null for a failed, refused, or empty
// search: none of those has a result set to come back to. A query containing `"` is quoted as-is,
// so the match is greedy to the last quote rather than the first.
export function parseSearchQuery(summary: string): string | null {
  const m = /^Found \d+ result\(s\) for "(.*)"( — already searched this session[^"]*)?$/.exec(
    summary,
  );
  return m ? m[1] : null;
}

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

      // A repeat of a query this session already ran is served from the saved results, ahead of
      // the latch and the budget: neither reaches upstream, and this does not either.
      const hit = savedSearches.get(query);
      if (hit) {
        return { summary: foundSummary(query, hit.count, true), payload: hit.payload };
      }

      // A provider-level failure already reported this turn: no browser, a bot check, every engine
      // refused. Re-attempting cannot succeed, so say so without spending a call or the budget —
      // the model was going to reword and try again otherwise, which is what burns a 3-search turn
      // on one condition. Worded as still-blocked rather than a fresh problem for the same reason.
      const latched = ctx.webHealth?.unavailable;
      if (latched) {
        return { summary: `Search still unavailable this turn: ${latched}` };
      }
      // The network is down (a fetch found out earlier this turn, #392): same treatment.
      const offline = ctx.webHealth?.offline;
      if (offline) {
        return { summary: `Search skipped: still offline this turn (${offline})` };
      }

      const budget = ctx.webBudget?.searches;
      if (budget && budget.used >= budget.max) {
        return {
          summary: `Search budget exceeded for this turn (max ${budget.max}). Summarize what you have or split into multiple turns.`,
        };
      }
      if (budget) budget.used++;
      // A bot check the provider raised for the user (#238). While it waits, the live tool line says
      // what the surfaced browser window is for; once cleared, a persistent receipt records that a
      // human stepped in — the results alone would not show it, and a transient spinner state is
      // gone by the time the user looks back.
      let cleared = false;
      const onChallenge = (state: 'raised' | 'cleared') => {
        if (state === 'raised') {
          ctx.onProgress?.(
            'The search engine served a bot check. Complete it in the browser window that just opened — the search resumes on its own.\n',
          );
        } else cleared = true;
      };
      const receipt = () =>
        cleared
          ? {
              notice: {
                tone: 'info' as const,
                content:
                  'Bot check completed in the search browser; the solve persists for its profile.',
              },
            }
          : {};
      try {
        const raw = await provider.search(query, { maxResults: 8, onChallenge });
        // Filter out results missing a URL — those are unusable for the model
        // (it can't cite or fetch them) and lead to "undefined" leaking into
        // citations downstream.
        const results = raw.filter(r => r.url && r.url.trim().length > 0);
        if (results.length === 0) {
          return { summary: `No results for "${query}"`, ...receipt() };
        }
        const payload = results
          .map((r, i) => `${i + 1}. ${r.title || '(no title)'}\n   ${r.url}\n   ${r.snippet || ''}`)
          .join('\n\n');
        savedSearches.set(query, { payload, count: results.length });
        return {
          summary: foundSummary(query, results.length, false),
          payload,
          ...receipt(),
        };
      } catch (e) {
        if (e instanceof SearchUnavailableError) {
          // Latch for the rest of the turn, and refund the call. The cap exists to stop runaway
          // loops hammering upstream engines (AGENTS.md); a search that never got an answer — a
          // missing browser reaches nothing at all — is not the egress it was built to limit.
          if (ctx.webHealth) ctx.webHealth.unavailable = e.message;
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
