import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import type { Tool } from '../types.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description:
    'Fetch a URL and return its main content extracted to markdown. Use after `search` to read a specific result in detail. Best for docs and articles; JS-heavy single-page apps may return little content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch (http/https).' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const url = String(args.url ?? '').trim();
    if (!url) return { summary: 'Fetch failed: empty URL' };
    if (!/^https?:\/\//i.test(url)) {
      return { summary: `Fetch failed: not an http(s) URL — ${url}` };
    }
    const budget = ctx.webBudget?.fetches;
    if (budget && budget.used >= budget.max) {
      return {
        summary: `Fetch budget exceeded for this turn (max ${budget.max}). Summarize what you have or split into multiple turns.`,
      };
    }
    if (budget) budget.used++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) {
        return { summary: `Fetch failed: ${url} (${res.status} ${res.statusText})` };
      }
      const html = await res.text();
      const dom = new JSDOM(html, { url });
      const result = await Defuddle(dom, url, { markdown: true });
      const content = result.content ?? '';
      const trimmed =
        content.length > MAX_PAYLOAD_BYTES
          ? content.slice(0, MAX_PAYLOAD_BYTES) +
            `\n…(truncated, ${content.length - MAX_PAYLOAD_BYTES} more chars)`
          : content;
      // Record the URL only on success so the loop can stamp it as a source on
      // the final assistant message. Failed fetches don't contribute.
      ctx.fetchedUrls?.add(url);
      return {
        summary: `Fetched ${url} (${content.length} chars extracted)`,
        payload: trimmed || '(no extractable content)',
      };
    } catch (e) {
      return { summary: `Fetch failed: ${url} (${(e as Error).message})` };
    } finally {
      clearTimeout(timer);
    }
  },
};
