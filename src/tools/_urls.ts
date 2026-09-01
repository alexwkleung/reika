import type { ToolContext } from '../types.js';
import { classifyPrivateUrl } from './_hosts.js';
import { extractUrl, type UrlExtraction } from './fetch.js';

// Local models sometimes write a plausible-looking URL into code or a comment — an API endpoint, a
// docs link, a `fetch()` target — that is subtly wrong or wholly invented. Unlike a hallucinated
// symbol (typecheck / groundcheck catch those) a bad URL fails silently: it survives the edit and
// only breaks at runtime. This grounds any http(s) URL a write/edit introduces by fetching it on the
// model's behalf — confirming the real ones with a short snippet and flagging the ones that don't
// resolve — so the model fixes a dead link instead of shipping it. Harness-driven and deterministic,
// mirroring tools/_deps.ts. Gated behind REIKA_URL_GROUNDING so it can be A/B'd; strict no-op when
// off or when the change names no URL.

// Cap URLs grounded per call so one change pasting a wall of links can't fan out a wall of fetches.
const MAX_URLS = 2;
// Tight per-URL snippet cap. The grounder confirms "this resolves and is roughly X", NOT "read me
// the page" — a small-context model can't afford a 64KB dump on every edit, and the window-physics
// cost would swamp the grounding value. The model can call `fetch_url` for the full content when it
// actually needs to read the page.
const MAX_SNIPPET_CHARS = 600;

// Bare http(s) URLs. The negated class stops at whitespace, quotes, backticks, angle brackets, and
// parens (markdown-link and code-string delimiters); trailing sentence punctuation is trimmed
// separately below. A URL that legitimately ends in such a char is rare enough to accept the miss —
// the one-directional bias mirrors groundcheck: a skipped URL is silent, a mangled one is noise.
const URL_RE = /\bhttps?:\/\/[^\s'"`<>()]+/g;

export function extractUrls(source: string): string[] {
  const urls = new Set<string>();
  for (const m of source.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    // A URL carrying a template-literal interpolation (`https://api/${id}`) is not a literal
    // address — fetching it verbatim just 404s and emits a false ✗. Skip it; literal URLs around it
    // still ground. One-directional like the rest of this module: a skipped URL is silent, a
    // mangled fetch is noise.
    if (url.includes('${')) continue;
    if (url.length > 'https://'.length) urls.add(url);
  }
  return [...urls];
}

export type UrlGroundingResult = { url: string; res: UrlExtraction };

// Per-URL verdict, accounting for whether the machine is even online:
//   reachable  — resolved (2xx).
//   dead       — a real bad link: the server answered with an error (4xx/5xx), OR the request got no
//                response BUT something else in the batch reached a server, proving we're online (so
//                a no-response here is a bad host, not a dead network).
//   unverified — got no response and we have NO proof of connectivity (e.g. the machine is offline).
//                Could be a bad host or could be the network — so we don't flag it as invented. This
//                is what stops an offline run from false-flagging every URL.
export type UrlVerdict = 'reachable' | 'dead' | 'unverified';

// Did any fetch in the batch reach a server (resolve, or get an HTTP error status)? That's proof the
// machine has connectivity, which is what lets us treat an unanswered request as a genuine bad host
// rather than a possibly-offline one.
function batchOnline(results: UrlGroundingResult[]): boolean {
  return results.some(r => r.res.ok || r.res.reached);
}

function verdictOf(res: UrlExtraction, online: boolean): UrlVerdict {
  if (res.ok) return 'reachable';
  if (res.reached || online) return 'dead';
  return 'unverified';
}

// Build the model-facing grounding note (edit/write path). Pure (no network) so formatting is
// testable in isolation. Returns '' when there's nothing to report. A ✗ (server-confirmed dead, or a
// bad host while online) is the high-signal case and is stated as an instruction to fix; a ✓ carries
// a whitespace-collapsed snippet; a ? (couldn't reach, maybe offline) is reported honestly as
// unverified, NOT as invented — so the model isn't told to "fix" a link that may be fine.
export function buildUrlGroundingNote(results: UrlGroundingResult[]): string {
  if (results.length === 0) return '';
  const online = batchOnline(results);
  const lines = results.map(({ url, res }) => {
    if (res.ok) {
      const snippet = res.content.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS);
      return snippet
        ? `✓ ${url} — resolved: ${snippet}…`
        : `✓ ${url} — resolved (no extractable text).`;
    }
    if (verdictOf(res, online) === 'dead') {
      return `✗ ${url} — did NOT resolve (${res.error}). Verify this URL is correct; do not assume it works.`;
    }
    return `? ${url} — no response (${res.error}); could not verify (the network may be down).`;
  });
  return (
    'URL grounding — fetched the URL(s) this change introduces, on your behalf. A ✗ means the link ' +
    'does not resolve (likely wrong or invented) — fix it before relying on it. A ✓ shows a snippet ' +
    'of the real page so you can confirm it matches your intent. A ? means it could not be reached at ' +
    'all (possibly an offline machine) — left unverified, not assumed wrong.\n\n' +
    lines.join('\n')
  );
}

// Build the user-facing notice for a grounding run — distinct from the model-facing note above: the
// user gets a short receipt that the harness fetched on its behalf and how it went. `warn` only when
// a link is genuinely dead (the actionable case); a batch that only failed to connect (no proof of
// connectivity) is reported as a quiet `info` "couldn't verify" — never a false dead-link alarm on
// an offline machine. Returns undefined for an empty run (caller emits nothing).
export function buildUrlGroundingNotice(
  results: UrlGroundingResult[],
): { tone: 'info' | 'warn'; content: string } | undefined {
  if (results.length === 0) return undefined;
  const n = results.length;
  const links = `${n} link${n === 1 ? '' : 's'}`;
  const online = batchOnline(results);
  const dead = results.filter(r => !r.res.ok && verdictOf(r.res, online) === 'dead');
  const unverified = results.filter(r => !r.res.ok && verdictOf(r.res, online) === 'unverified');
  if (dead.length > 0) {
    // Name the dead ones (capped) — that's the actionable detail; the rest is a count.
    const named = dead
      .slice(0, 2)
      .map(r => (r.res.ok ? '' : `${r.url} (${r.res.error})`))
      .join(', ');
    const more = dead.length > 2 ? `, +${dead.length - 2} more` : '';
    return {
      tone: 'warn',
      content: `Grounded ${links} — ${dead.length} unreachable: ${named}${more}.`,
    };
  }
  if (unverified.length > 0) {
    return {
      tone: 'info',
      content: `Grounded ${links} — couldn't verify ${unverified.length} (no response; network may be down).`,
    };
  }
  return { tone: 'info', content: `Grounded ${links} — all reachable.` };
}

// Flag-only note for a finalized plan, mirroring groundcheck.ts's symbol/path advisory: lists the
// URLs the plan named that did NOT resolve (likely wrong or invented). Returns '' when every URL
// resolved — a plan needs dead links called out, not page contents pasted in (that's the edit-path
// note's job). URLs are backticked so the TUI markdown leaves them literal.
export function buildPlanUrlNote(results: UrlGroundingResult[]): string {
  const online = batchOnline(results);
  // Only flag genuinely-dead links — never the 'unverified' (couldn't-reach, maybe-offline) ones, so
  // a plan written on an offline machine isn't stamped with phantom "invented URL" warnings.
  const dead = results.filter(r => !r.res.ok && verdictOf(r.res, online) === 'dead');
  if (dead.length === 0) return '';
  const list = dead.map(r => (r.res.ok ? '' : `\`${r.url}\` (${r.res.error})`)).join(', ');
  return (
    '\n\n--- reika: plan URL check (auto-generated) ---\n' +
    `These URLs named in the plan did not resolve: ${list}. ` +
    'They may be wrong or invented — verify them before relying on them; do not write a dead link.'
  );
}

// A grounding outcome: `note` is the text to inject (model-facing snippets for the edit path, a
// flag-only advisory for the plan path); `notice` is the user-facing receipt the caller emits as a
// scrollback line AFTER the action it describes. Both undefined when nothing was grounded.
export type UrlGroundingOutcome = {
  note?: string;
  notice?: { tone: 'info' | 'warn'; content: string };
};

// Shared core: fetch the URLs in `text` not already grounded this turn and return the raw results.
// Strict no-op (returns []) when the flag is off or nothing new is named. Marks every candidate seen
// — resolved or not — so a URL isn't re-fetched on a later edit. Fetches run in parallel, so
// wall-clock is one timeout, not N. Both entry points below share this; they differ only in how they
// render the results into a note. Emits nothing itself: the caller owns where the receipt lands.
async function groundCandidates(ctx: ToolContext, text: string): Promise<UrlGroundingResult[]> {
  if (process.env.REIKA_URL_GROUNDING !== '1') return [];
  const seen = ctx.groundedUrls;
  const eligible = extractUrls(text)
    .filter(u => !seen?.has(u))
    // Drop private/loopback addresses BEFORE the cap rather than letting extractUrl refuse them.
    // extractUrl would refuse correctly, but the refusal would then be rendered as a ✗ "did NOT
    // resolve — likely wrong or invented", and a localhost URL in a config file is usually neither:
    // this project's own model server is one. Silence is the honest report for an address we chose
    // not to check, and filtering first also stops two such URLs from eating the whole per-call cap.
    .filter(u => !classifyPrivateUrl(u));

  // Grounding is harness-driven — the model never asked for these fetches — so it must answer to
  // the same per-turn cap as the ones it does ask for (fetch.ts). Without this, N edits in a turn
  // was up to 2N uncounted requests, and the cap AGENTS.md calls the runaway guard only ever saw
  // the tool-call half of the traffic. Degrades quietly by taking what's left rather than
  // returning an error the way fetch_url does: nothing here was requested, so there is nobody to
  // report a budget refusal to, and a note saying so would be pure noise in the model's context.
  const budget = ctx.webBudget?.fetches;
  const room = budget ? Math.max(0, budget.max - budget.used) : Number.POSITIVE_INFINITY;
  const candidates = eligible.slice(0, Math.min(MAX_URLS, room));
  if (candidates.length === 0) return [];
  if (budget) budget.used += candidates.length;
  candidates.forEach(u => seen?.add(u));

  return Promise.all(candidates.map(async url => ({ url, res: await extractUrl(url) })));
}

// Ground the http(s) URLs a write/edit introduces. The note carries a snippet of each real page (for
// the model); the notice is the user's receipt. The tool puts the note on its payload and the notice
// on its ToolResult, so the loop renders the receipt after the edit chip.
export async function groundUrls(ctx: ToolContext, newText: string): Promise<UrlGroundingOutcome> {
  const results = await groundCandidates(ctx, newText);
  return {
    note: buildUrlGroundingNote(results) || undefined,
    notice: buildUrlGroundingNotice(results),
  };
}

// Ground the http(s) URLs a finalized plan names — the plan-commit analogue of the symbol/path
// groundcheck. The note is a flag-only advisory listing the unreachable ones (appended to the plan so
// it's inherited verbatim by the agent turn); the notice is the user's receipt. Catches URLs that
// live only in a plan or prose and never reach a write, where groundUrls would never see them.
export async function groundUrlsForPlan(
  ctx: ToolContext,
  planText: string,
): Promise<UrlGroundingOutcome> {
  const results = await groundCandidates(ctx, planText);
  return { note: buildPlanUrlNote(results) || undefined, notice: buildUrlGroundingNotice(results) };
}
