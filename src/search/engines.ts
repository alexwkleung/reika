// The result pages the search browser can read. Each entry is what differs between engines; the
// collector, the result filter and the fallback in `cdp.ts` are shared. The order is the one place
// that decides which engine is asked first (#1130).
//
// Both engines return the result's real address in the link, or one that can be decoded from it.
// Google and Bing were measured and rejected for not doing that: every outbound link goes through
// an opaque tracker, and 0 of 53 and 0 of 46 visible links survived to a usable URL (#235). Brave
// started doing the same in November 2026: most of its ranked results now link to
// `search.brave.com/go/v1#<token>`, with the destination nowhere on the page, so only its direct
// links (knowledge-panel and some ranked results) are usable.

export type SearchEngine = {
  name: 'duckduckgo' | 'brave';
  searchUrl(query: string): string;
  // The engine's own pages, never results.
  ownHosts: RegExp;
  // The real address inside a wrapped link, or undefined when the link is not wrapped.
  unwrap?(url: URL): string | undefined;
  // The engine's bot-check wording, beside the shared phrases in `cdp.ts`.
  challengeText: RegExp;
  // Fewer links than this with no results reads as an interstitial, not an empty search.
  minAnchors: number;
};

export const DUCKDUCKGO: SearchEngine = {
  name: 'duckduckgo',
  // The HTML version: no script-built page to wait for, real titles in the link text, and every
  // result's address in the `uddg` parameter of its link.
  searchUrl: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  ownHosts: /(^|\.)(duckduckgo\.com|duck\.com|duck\.ai)$/,
  unwrap: u =>
    /(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname === '/l/'
      ? (u.searchParams.get('uddg') ?? undefined)
      : undefined,
  challengeText: /bots use duckduckgo|confirm this search was made by a human|select all squares/i,
  minAnchors: 10,
};

export const BRAVE: SearchEngine = {
  name: 'brave',
  searchUrl: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  ownHosts: /(^|\.)(brave\.com|brave\.app)$/,
  challengeText: /verifying you|traditional captcha/i,
  minAnchors: 10,
};

export const ENGINE_ORDER: readonly SearchEngine[] = [DUCKDUCKGO, BRAVE];
