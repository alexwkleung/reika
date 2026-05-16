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
    async run(args) {
      const query = String(args.query ?? '').trim();
      if (!query) return { summary: 'Search failed: empty query' };
      try {
        const results = await provider.search(query, { maxResults: 8 });
        if (results.length === 0) {
          return { summary: `No results for "${query}"` };
        }
        const payload = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
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
