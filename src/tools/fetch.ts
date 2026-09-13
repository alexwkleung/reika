import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import type { Tool } from '../types.js';
import { classifyPrivateUrl } from './_hosts.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import { recordCapped } from './_spillstats.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
// Above this many extracted chars the fetch_url tool saves the whole page to a spill file, even
// when the page is well under MAX_PAYLOAD_BYTES. The search tools spill only what their own cap
// drops; fetch has a second, earlier cut it cannot see — the context window. A page that fits the
// tool cap can still be chopped at serialization (`capPayload`, provider/toolcall.ts) once the
// window is nearly full, and the marker left at that cut tells the model to "read a narrower line
// range". For every other tool that is a real remedy; for fetch_url there IS no narrower fetch,
// so the model's only moves were a re-fetch (same page, chopped the same way) or bash curl (a
// second egress, raw HTML, chopped the same way). The spill file makes the marker's advice true:
// the page is a local file, and `read` takes a line range (#139). The threshold is the window
// floor the serializer never cuts below (SMALL_PAYLOAD_FLOOR_CHARS): a payload that small is
// always delivered whole, so a file for it would be one nobody follows.
const SPILL_MIN_CHARS = 2048;
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
  // Return the extraction uncut. Only the fetch_url tool sets it, to hold the page for spilling;
  // the grounders keep the default cap (they re-slice to their own smaller limits anyway) so a
  // grounding check never writes a file whose locator nobody sees. Peak memory is the same either
  // way — the full extraction is in memory before the cap is applied.
  untruncated?: boolean;
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
// `content` is truncated to MAX_PAYLOAD_BYTES unless `untruncated` is set; `extractedChars` is the
// pre-truncation length, for an honest "N chars extracted" summary.
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
        // Drain the redirect's body before moving on. `redirect: 'manual'` hands back a real
        // response per hop, and an unread body keeps its connection out of undici's pool until GC
        // — invisible in tests, since nothing throws, but a 20-hop chain leaves 20 of them.
        // `follow` did this internally; walking the chain ourselves means owning it.
        await res.body?.cancel().catch(() => {});
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
        !opts.untruncated && content.length > MAX_PAYLOAD_BYTES
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
    // Read once per call, like bash: the cap below must match the extraction it is applied to.
    const spilling = spillEnabled();
    const result = await extractUrl(url, { untruncated: spilling });
    if (!result.ok) {
      return { summary: `Fetch failed: ${url} (${result.error})` };
    }
    // Record the URL only on success so the loop can stamp it as a source on
    // the final assistant message. Failed fetches don't contribute.
    ctx.fetchedUrls?.add(url);
    const full = result.content;
    const total = result.extractedChars;
    const overCap = total > MAX_PAYLOAD_BYTES;
    // Recorded whether or not spilling is on, same as bash: the stat is how often a page exceeds
    // the tool cap at all. The spilling arm records below instead, after the write.
    if (overCap && !spilling) {
      recordCapped({ tool: 'fetch_url', total, shown: MAX_PAYLOAD_BYTES, spilled: false });
    }
    // Spilling off, or a page under the floor: the ordinary result, byte-identical to the
    // pre-spill behavior so the flag is a clean A/B.
    if (!spilling || total <= SPILL_MIN_CHARS) {
      return {
        summary: `Fetched ${url} (${total} chars extracted)`,
        payload: full || '(no extractable content)',
      };
    }
    const ref = await spillResult('fetch', full);
    if (overCap) {
      recordCapped({ tool: 'fetch_url', total, shown: MAX_PAYLOAD_BYTES, spilled: !!ref });
    }
    const shown = overCap ? full.slice(0, MAX_PAYLOAD_BYTES) : full;
    if (!ref) {
      // Fail-open: the capped page the tool always returned, with the honest footer when the cap
      // actually dropped something. A page under the cap that merely failed to spill is exactly the
      // old result, and gets no footer at all.
      const footer = overCap
        ? buildCappedFooter({
            shown: MAX_PAYLOAD_BYTES,
            total: String(total),
            unit: 'chars',
            advice: 'work from the head shown above',
          })
        : '';
      return { summary: `Fetched ${url} (${total} chars extracted)`, payload: shown + footer };
    }
    // The locator rides the SUMMARY as well as the footer, and that is the opposite of the choice
    // the search tools made (`buildSpillFooter`). Their reasoning — the summary outlives payload
    // aging, and by then a locator is stale advice — is about a page the model has already moved
    // past. A fetched page is different: the model comes back to it (the same URL re-fetched is
    // the loop #296 describes), and the summary is also the only part of the result that survives
    // a fully-starved window (`capPayload` at cap <= 0 drops the entire payload, footer included).
    // In both of those places the locator is the re-fetch avoided, not stale advice.
    const footer = overCap
      ? buildSpillFooter({
          shown: MAX_PAYLOAD_BYTES,
          total: String(total),
          unit: 'chars',
          ref,
          saved: 'Full page',
          subject: 'fetch',
        })
      : `\n\n(Full page saved to ${ref.path} — if this output is cut to fit the context window, ` +
        `read that path with offset/limit instead of fetching the URL again.)`;
    return {
      summary: `Fetched ${url} (${total} chars extracted; full page saved to ${ref.path})`,
      payload: shown + footer,
    };
  },
};
