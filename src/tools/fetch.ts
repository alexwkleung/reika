import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import type { Tool } from '../types.js';
import { classifyPrivateUrl } from './_hosts.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
// Redirect hops followed before giving up. The chain is walked here rather than handed to fetch's
// own `redirect: 'follow'` because the host policy has to see every hop: a public URL that 302s to
// 127.0.0.1 would otherwise pass the check on the URL as written and land on the local address
// anyway. Twenty because that is exactly what `redirect: 'follow'` did before this walk existed
// (the WHATWG limit undici implements — measured, not assumed: a 19-hop chain resolved and a
// 21-hop chain threw `redirect count exceeded`). Taking the check into our own hands should not
// quietly shorten what a URL is allowed to do; the policy comes from inspecting each hop, not from
// permitting fewer of them.
const MAX_REDIRECTS = 20;

export type UrlExtraction =
  | { ok: true; content: string; extractedChars: number }
  // `reached` distinguishes "the server answered, with an error status" (reached: true — a 4xx/5xx,
  // a definitively bad URL) from "the request never got a response" (reached: false — DNS failure,
  // refused connection, timeout, or no internet at all). The two are indistinguishable in `error`
  // text but mean very different things to a grounder: a 404 is a real dead link; a thrown request
  // might just be an offline machine, so it must not be reported as an invented URL on its own.
  | { ok: false; reached: boolean; error: string };

export type ExtractOptions = {
  // Allow addresses that only resolve on this machine or this LAN (loopback, RFC1918, link-local).
  // Off by default: the model-driven and harness-driven paths must not reach the local model
  // server or a metadata endpoint. The one caller that sets it is pasted-URL expansion, where the
  // user typed the address themselves — "read my dev server at http://localhost:3000" is a request,
  // not an injection, and refusing it would break an ordinary workflow to stop nothing.
  allowPrivate?: boolean;
};

// 303 and 307/308 are included alongside the classic 301/302: all of them move the request to a new
// address, which is the only property that matters for the policy.
function redirectLocation(res: Response): string | undefined {
  if (res.status < 300 || res.status > 399) return undefined;
  return res.headers?.get?.('location') ?? undefined;
}

// Fetch an http(s) URL and extract its main content to truncated markdown. Budget accounting and
// source bookkeeping still belong to the callers (the fetch_url tool below, and the harness-driven
// grounders that fetch on the model's behalf rather than waiting for it to call the tool), but the
// HOST POLICY lives here and not with them: this is the one point every egress path funnels
// through, and it is the only place that sees the redirect chain, which is where a check on the
// caller's side would be walked around. Callers still validate the URL's shape before calling.
// `content` is already truncated to MAX_PAYLOAD_BYTES; `extractedChars` is the pre-truncation
// length, for an honest "N chars extracted" summary.
export async function extractUrl(url: string, opts: ExtractOptions = {}): Promise<UrlExtraction> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!opts.allowPrivate) {
        const blocked = classifyPrivateUrl(current);
        if (blocked) {
          // `reached: false` is accurate — no request went out. The message names the range and
          // says the address is off limits rather than missing, so a model reading it fixes the
          // URL instead of retrying the same one against a "maybe the network is down" reading.
          const where = hop === 0 ? '' : ` (redirected to ${current})`;
          return {
            ok: false,
            reached: false,
            error: `blocked by host policy: ${blocked}${where}`,
          };
        }
      }
      const res = await fetch(current, { signal: controller.signal, redirect: 'manual' });
      const location = redirectLocation(res);
      if (location !== undefined) {
        // Resolve against the current URL so a relative Location works, then loop to re-check the
        // new address against the policy before following it.
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return { ok: false, reached: true, error: `${res.status} ${res.statusText}` };
      const html = await res.text();
      const dom = new JSDOM(html, { url: current });
      const result = await Defuddle(dom, current, { markdown: true });
      const content = result.content ?? '';
      const trimmed =
        content.length > MAX_PAYLOAD_BYTES
          ? content.slice(0, MAX_PAYLOAD_BYTES) +
            `\n…(truncated, ${content.length - MAX_PAYLOAD_BYTES} more chars)`
          : content;
      return { ok: true, content: trimmed, extractedChars: content.length };
    }
    return { ok: false, reached: true, error: `too many redirects (${MAX_REDIRECTS})` };
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
