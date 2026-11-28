import type { SearchEngine } from './engines.js';

// What the page script records for each link. The page only collects; every decision about what
// counts as a result is made in `pickResults`, in Node, so it can be tested against links recorded
// from real result pages (`extract.corpus.json`). A redesign that empties the results then fails
// a test instead of reaching the model as a search that found nothing (#1130).
export type LinkRecord = {
  href: string;
  // `innerText` is what a reader sees, with line breaks between blocks; it comes back empty for
  // some elements while the window is minimized (the document reports itself hidden), so the
  // flattened `textContent` is kept beside it as the fallback.
  inner: string;
  text: string;
  visible: boolean;
  // Inside the page's header, footer or navigation: the engine's own links, never results.
  chrome: boolean;
  snippet: string;
};

export type PageRecord = {
  links: LinkRecord[];
  anchors: number;
  // The page's visible text, for the bot-check wording. Capped, since only the phrases matter.
  bodyText: string;
};

// Engines end some result anchors with a date line ("May 8, 2026", "3 days ago"), which the
// last-line rule below would otherwise report as the result's title.
export const DATE_LINE =
  /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|\d+ (?:second|minute|hour|day|week|month|year)s? ago)$/i;

const MAX_LINKS = 400;
const BODY_TEXT_CHARS = 4000;

// Deliberately structure-agnostic: every link, with no result-card selectors, so a redesign
// degrades quality rather than silently emptying the results the way class-name scraping does.
// The snippet walks up from the anchor until a container holds meaningfully more text than the
// anchor, which needs no knowledge of the markup either.
export function collectScript(): string {
  return `(() => {
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  };
  const chromeSel = 'header,footer,nav,[role=banner],[role=contentinfo],[role=navigation]';
  // The container repeats the anchor's own text before the description; removing it stops every
  // snippet from opening with a copy of the title it sits under.
  const snippetFor = a => {
    const own = clean(a.textContent);
    let node = a.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      // Stop before climbing into a container that groups several results, or the snippet picks up
      // the *next* result's title. A block holding many links is a group, not one result's body.
      if (node.querySelectorAll('a[href]').length > 3) break;
      const full = clean(node.textContent);
      if (full.length <= own.length + 40) continue;
      const body = clean(full.split(own).join(' '));
      if (body.length >= 20) return body.slice(0, 300);
    }
    return '';
  };
  const all = document.querySelectorAll('a[href]');
  const links = [];
  for (const a of all) {
    if (links.length >= ${MAX_LINKS}) break;
    links.push({
      href: a.href,
      inner: a.innerText || '',
      text: clean(a.textContent),
      visible: visible(a),
      chrome: !!a.closest(chromeSel),
      snippet: snippetFor(a),
    });
  }
  const body = document.body ? document.body.innerText || document.body.textContent || '' : '';
  return JSON.stringify({ links, anchors: all.length, bodyText: body.slice(0, ${BODY_TEXT_CHARS}) });
})()`;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

// A result anchor's innerText is often "SiteName / breadcrumb › path / actual title" on separate
// lines. The last line is the title; the earlier ones are chrome that would otherwise be fed to the
// model as part of it. When innerText is empty, the flattened text is all there is.
export function titleOf(link: LinkRecord): string {
  const lines = link.inner.split('\n').map(clean).filter(Boolean);
  const named = lines.filter(l => !DATE_LINE.test(l));
  return named.length ? named[named.length - 1] : link.text;
}

export type PickedResult = { title: string; url: string; snippet: string };

const keyOf = (url: URL): string => url.hostname + url.pathname;

// Prose, not an address: a page's URL printed as link text has no spaces.
const looksLikeProse = (s: string): boolean => (s.match(/ /g) ?? []).length >= 4;

export function pickResults(page: PageRecord, engine: SearchEngine, max: number): PickedResult[] {
  // Some engines make the description a link of its own to the same page, so the result's
  // container holds several links and the snippet walk stops short of it. The longest prose among
  // a page's other links is then its description.
  const descriptions = new Map<string, string>();
  for (const link of page.links) {
    if (!link.visible || link.chrome || !looksLikeProse(link.text)) continue;
    const url = resultUrl(link.href, engine);
    if (!url) continue;
    const key = keyOf(url);
    if (link.text.length > (descriptions.get(key)?.length ?? 0)) descriptions.set(key, link.text);
  }
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const results: PickedResult[] = [];
  for (const link of page.links) {
    if (results.length >= max) break;
    if (!link.visible || link.chrome) continue;
    const title = titleOf(link);
    if (title.length < 8) continue;
    const url = resultUrl(link.href, engine);
    if (!url) continue;
    const key = keyOf(url);
    if (seen.has(key)) continue;
    // A result with a nested sub-link cluster (issues, discussions) contributes a run of tightly
    // packed anchors from one host in DOM order, which crowds out every lower-ranked result. Two
    // per host keeps that from turning the slots into one site's sitemap.
    const used = perHost.get(url.hostname) ?? 0;
    if (used >= 2) continue;
    perHost.set(url.hostname, used + 1);
    seen.add(key);
    const description = descriptions.get(key);
    const snippet =
      link.snippet || (description && description.length > title.length ? description : '');
    results.push({ title: title.slice(0, 180), url: url.href, snippet: snippet.slice(0, 300) });
  }
  return results;
}

// The address a result points at, or undefined for the engine's own links and anything that is
// not a web page. An engine that wraps its links decodes them here, from the link alone: no
// request is made, so no redirect is followed and nothing is reported back to the engine.
function resultUrl(href: string, engine: SearchEngine): URL | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  const unwrapped = engine.unwrap?.(u);
  if (unwrapped !== undefined) {
    try {
      u = new URL(unwrapped);
    } catch {
      return undefined;
    }
  }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  if (engine.ownHosts.test(u.hostname)) return undefined;
  return u;
}
