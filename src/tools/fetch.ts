import { readFile } from 'node:fs/promises';
import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { classifyPrivateUrl } from './_hosts.js';
import { errorCode, offlineCode, rootMessage } from './_net.js';
import {
  buildCappedFooter,
  buildSpillFooter,
  spillEnabled,
  spillResult,
  type SpillRef,
} from './_spill.js';
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

// Pages saved this session, by URL (#296). A model whose earlier fetch has aged out of the window
// fetches the same URL again — the extraction is the expensive part upstream (a second full
// request for bytes we already hold, and enough of them in a session to read as a bot), and the
// re-fetch returns the same page to be chopped the same way. Once the page is on disk the repeat
// is served from the file: no request, no budget, same result shape, and a summary that says so.
// Session-scoped by construction — the spill directory is per process and removed on exit — and
// keyed on the URL as the model wrote it, because that is what the model repeats. Not an eviction
// exemption (the alternative #296 proposed): the page's bytes still age out of context like any
// other payload; what stays is the one summary line that says where they are.
const savedPages = new Map<string, { ref: SpillRef; total: number }>();

// Reset between tests, alongside `resetSpillDir`: a fresh spill directory means these paths point
// at nothing, and the miss path below would recover anyway, but a test should not depend on it.
export function resetSavedPages(): void {
  savedPages.clear();
}

// The one summary shape for a saved page, fresh or served from the file: `compaction.ts` reads the
// locator back out of it for the recap's "Pages fetched" line, so the tail must stay parseable.
// Without a `path` — a model that cannot follow one (#377) — the locator clause is left off and
// the summary is the unsaved shape, which `parseSavedPage` rejects: the recap has no business
// listing a file for a model that has no way to open it either.
function savedSummary(url: string, total: number, cached: boolean, path?: string): string {
  const how = cached ? ' — already fetched this session, served from the saved copy' : '';
  const where = path ? `; full page saved to ${path}` : '';
  return `Fetched ${url} (${total} chars extracted${how}${where})`;
}

// Whether the model can follow a spill locator. The footer names `read` (and `grep`; bash works
// too), and every tool list that has any of them has `read` — plan mode has read+grep, agent mode
// all three — so `read` alone is the key. Chat mode has none of them (fetch_url and search only,
// `chatTools`), and a locator handed to it is a dead end: `read` comes back "Unknown tool", and
// fetching the path comes back "not an http(s) URL" (#377). Unknown (no list passed — a test, or
// a caller outside the loop) is treated as the agent set, so the default result is unchanged.
function canFollowLocator(ctx: ToolContext): boolean {
  return ctx.toolNames ? ctx.toolNames.has('read') : true;
}

// Locator and URL out of a fetch_url summary, for the recap. Null for a failed fetch, a page too
// small to have been saved, and a spill that did not land.
export function parseSavedPage(summary: string): { url: string; path: string } | null {
  const m = /^Fetched (\S+) \(.*; full page saved to (\S+)\)$/.exec(summary);
  return m ? { url: m[1], path: m[2] } : null;
}
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
  // `code` is the socket-level error code when the failure had one (ENOTFOUND, ECONNREFUSED…),
  // dug out of undici's `cause` chain. It is what separates "this host" from "no network" for the
  // tool's offline latch; the grounders read only `reached`.
  | { ok: false; reached: boolean; error: string; code?: string };

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
    // undici reports every socket failure as `TypeError: fetch failed` and keeps the real error
    // on `cause`. The outer text tells a model nothing — "fetch failed" reads as "try again" —
    // so the message and code come from the root of the chain.
    const code = errorCode(e);
    return { ok: false, reached: false, error: rootMessage(e), ...(code ? { code } : {}) };
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
    // Read once per call, like bash: the cap below must match the extraction it is applied to.
    const spilling = spillEnabled();
    // A page already saved this session is served from the file, ahead of the budget check: the
    // budget bounds egress, and this is none. A file that cannot be read (it should not happen
    // while the session lives, but fail-open is the rule) falls through to an ordinary fetch.
    const hit = spilling ? savedPages.get(url) : undefined;
    if (hit) {
      const full = await readFile(hit.ref.path, 'utf8').catch(() => undefined);
      if (full !== undefined) {
        ctx.fetchedUrls?.add(url);
        return presentSaved(url, full, hit.total, hit.ref, true, canFollowLocator(ctx));
      }
      savedPages.delete(url);
    }
    // The network went down earlier this turn (#392): every URL fails the same way, so say so
    // without a request or a budget slot. After the saved-page check, which needs no network.
    const offline = ctx.webHealth?.offline;
    if (offline) {
      return { summary: `Fetch skipped: still offline this turn (${offline})` };
    }
    const budget = ctx.webBudget?.fetches;
    if (budget && budget.used >= budget.max) {
      return {
        summary: `Fetch budget exceeded for this turn (max ${budget.max}). Summarize what you have or split into multiple turns.`,
      };
    }
    if (budget) budget.used++;
    const result = await extractUrl(url, { untruncated: spilling });
    if (!result.ok) {
      const down = offlineCode(result);
      if (down) {
        // Latch the turn and refund the call, as the search tool does for a refused provider: the
        // budget bounds egress, and a request that never left the machine is none. The notice is
        // for the user and emitted once, on the failure that sets the latch.
        if (ctx.webHealth) ctx.webHealth.offline = down;
        if (budget) budget.used--;
        return {
          summary: `Fetch failed: ${url} (${result.error}) — the network is unreachable, so no web call can succeed this turn`,
          notice: {
            tone: 'warn',
            content: `Network unreachable (${down}) — web tools are paused for the rest of this turn.`,
          },
        };
      }
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
    savedPages.set(url, { ref, total });
    return presentSaved(url, full, total, ref, false, canFollowLocator(ctx));
  },
};

// The result for a page that is on disk — fresh from the network or served from the file. The
// locator rides the SUMMARY as well as the footer, and that is the opposite of the choice the
// search tools made (`buildSpillFooter`). Their reasoning — the summary outlives payload aging,
// and by then a locator is stale advice — is about a page the model has already moved past. A
// fetched page is different: the model comes back to it (the same URL re-fetched is the loop
// #296 describes), and the summary is also the only part of the result that survives a
// fully-starved window (`capPayload` at cap <= 0 drops the entire payload, footer included). In
// both of those places the locator is the re-fetch avoided, not stale advice.
//
// `locate` false (#377) keeps the file — the repeat-fetch cache above is served from it and needs
// no help from the model — but says nothing about it: the summary is the unsaved shape, an
// under-cap page gets no footer, and an over-cap page gets a footer that owns the cut without
// naming a remedy. Not `buildCappedFooter`: its "could not be saved" is the wrong lie in the other
// direction. What the model gets is the pre-spill result for the tool cap, which is the right
// floor for a mode that never had a way past it, plus the one sentence that stops the re-fetch.
function presentSaved(
  url: string,
  full: string,
  total: number,
  ref: SpillRef,
  cached: boolean,
  locate: boolean,
): ToolResult {
  const overCap = total > MAX_PAYLOAD_BYTES;
  const shown = overCap ? full.slice(0, MAX_PAYLOAD_BYTES) : full;
  if (!locate) {
    const footer = overCap
      ? `\n\n(Showing ${MAX_PAYLOAD_BYTES} of ${total} chars. The rest is not reachable in this ` +
        `mode — work from the head shown above. Do not re-run this fetch to see it.)`
      : '';
    return { summary: savedSummary(url, total, cached), payload: shown + footer };
  }
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
  return { summary: savedSummary(url, total, cached, ref.path), payload: shown + footer };
}
