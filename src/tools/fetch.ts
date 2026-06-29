import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import type { Tool } from '../types.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export type UrlExtraction =
  | { ok: true; content: string; extractedChars: number }
  // `reached` distinguishes "the server answered, with an error status" (reached: true — a 4xx/5xx,
  // a definitively bad URL) from "the request never got a response" (reached: false — DNS failure,
  // refused connection, timeout, or no internet at all). The two are indistinguishable in `error`
  // text but mean very different things to a grounder: a 404 is a real dead link; a thrown request
  // might just be an offline machine, so it must not be reported as an invented URL on its own.
  | { ok: false; reached: boolean; error: string };

// Fetch an http(s) URL and extract its main content to truncated markdown. Network + extraction
// ONLY — no validation, budget accounting, or source bookkeeping; every caller owns those (the
// fetch_url tool below, and harness-driven grounders that fetch URLs on the model's behalf rather
// than waiting for it to call the tool). `content` is already truncated to MAX_PAYLOAD_BYTES;
// `extractedChars` is the pre-truncation length, for an honest "N chars extracted" summary. Assumes
// a well-formed http(s) URL — callers validate before calling.
export async function extractUrl(url: string): Promise<UrlExtraction> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, reached: true, error: `${res.status} ${res.statusText}` };
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const result = await Defuddle(dom, url, { markdown: true });
    const content = result.content ?? '';
    const trimmed =
      content.length > MAX_PAYLOAD_BYTES
        ? content.slice(0, MAX_PAYLOAD_BYTES) +
          `\n…(truncated, ${content.length - MAX_PAYLOAD_BYTES} more chars)`
        : content;
    return { ok: true, content: trimmed, extractedChars: content.length };
  } catch (e) {
    return { ok: false, reached: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

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
    const result = await extractUrl(url);
    if (!result.ok) {
      return { summary: `Fetch failed: ${url} (${result.error})` };
    }
    // Record the URL only on success so the loop can stamp it as a source on
    // the final assistant message. Failed fetches don't contribute.
    ctx.fetchedUrls?.add(url);
    return {
      summary: `Fetched ${url} (${result.extractedChars} chars extracted)`,
      payload: result.content || '(no extractable content)',
    };
  },
};
