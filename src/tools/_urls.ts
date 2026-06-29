import type { ToolContext } from '../types.js';
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

// Build the grounding note from fetched results. Pure (no network) so the formatting is testable in
// isolation. Returns '' when there's nothing to report, so the caller appends nothing. A ✗ (did not
// resolve) is the high-signal case — a likely-hallucinated link — and is stated as an instruction to
// fix; a ✓ carries a whitespace-collapsed snippet so the model can confirm the page matches intent.
export function buildUrlGroundingNote(results: UrlGroundingResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map(({ url, res }) => {
    if (!res.ok) {
      return `✗ ${url} — did NOT resolve (${res.error}). Verify this URL is correct; do not assume it works.`;
    }
    const snippet = res.content.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS);
    return snippet ? `✓ ${url} — resolved: ${snippet}…` : `✓ ${url} — resolved (no extractable text).`;
  });
  return (
    'URL grounding — fetched the URL(s) this change introduces, on your behalf. A ✗ means the link ' +
    'does not resolve (likely wrong or invented) — fix it before relying on it. A ✓ shows a snippet ' +
    'of the real page so you can confirm it matches your intent.\n\n' +
    lines.join('\n')
  );
}

// Build the user-facing notice for a grounding run — distinct from the model-facing note above: the
// model gets the snippets, the user gets a short receipt that the harness fetched on its behalf and
// how it went. `warn` when any link was unreachable (the case worth noticing — a likely-bad URL),
// `info` otherwise (a quiet "this ran"). Returns undefined for an empty run (caller emits nothing).
export function buildUrlGroundingNotice(
  results: UrlGroundingResult[],
): { tone: 'info' | 'warn'; content: string } | undefined {
  if (results.length === 0) return undefined;
  const n = results.length;
  const links = `${n} link${n === 1 ? '' : 's'}`;
  const unreachable = results.filter(r => !r.res.ok);
  if (unreachable.length === 0) {
    return { tone: 'info', content: `Grounded ${links} — all reachable.` };
  }
  // Name the unreachable ones (capped) — that's the actionable detail; the rest is a count.
  const named = unreachable
    .slice(0, 2)
    .map(r => (r.res.ok ? '' : `${r.url} (${r.res.error})`))
    .join(', ');
  const more = unreachable.length > 2 ? `, +${unreachable.length - 2} more` : '';
  return {
    tone: 'warn',
    content: `Grounded ${links} — ${unreachable.length} unreachable: ${named}${more}.`,
  };
}

// Ground the http(s) URLs a write/edit introduces: fetch the ones not already grounded this turn and
// return a note block for the tool result (or undefined when there's nothing to ground). Marks every
// candidate seen — resolved or not — so a URL isn't re-fetched on each subsequent edit. Fetches run
// in parallel, so wall-clock is one fetch timeout, not N.
export async function groundUrls(ctx: ToolContext, newText: string): Promise<string | undefined> {
  if (process.env.REIKA_URL_GROUNDING !== '1') return undefined;
  const seen = ctx.groundedUrls;
  const candidates = extractUrls(newText)
    .filter(u => !seen?.has(u))
    .slice(0, MAX_URLS);
  if (candidates.length === 0) return undefined;
  candidates.forEach(u => seen?.add(u));

  const results = await Promise.all(
    candidates.map(async url => ({ url, res: await extractUrl(url) })),
  );
  // Tell the user it ran (and how it went) — a network fetch on its behalf shouldn't be invisible.
  const notice = buildUrlGroundingNotice(results);
  if (notice) ctx.onNotice?.(notice);
  return buildUrlGroundingNote(results) || undefined;
}
