import { debugLog } from '../debug.js';
import { ChromeHost, type BrowserHost, type TabHandle } from './_chrome.js';
import { SearchUnavailableError } from './types.js';
import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

// Brave, not Google. Measured on a live SERP: Google and Bing launder every outbound link through
// an opaque tracker (`google.com/goto?url=…`, `bing.com/ck/a?…`) — 0 of 53 and 0 of 46 visible links
// respectively survive to a usable URL, and `cite` is a display string, not a fallback ("2 answers ·
// 2 years ago"). Brave hands back the real href. It also runs its own index rather than reselling
// Bing, so it isn't correlated with the engine most likely to block us next. See #235.
const SEARCH_URL = 'https://search.brave.com/search?q=';
const OWN_HOSTS = /(^|\.)(brave\.com|search\.brave\.com)$/;

// Deliberately structure-agnostic: every visible link, filtered and deduped. No result-card
// selectors, so a SERP redesign can't silently empty the results the way class-name scraping does.
// The snippet walks up from the anchor until a container holds meaningfully more text than the
// title, which needs no knowledge of the markup either.
function extractionScript(maxResults: number): string {
  return `(() => {
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  };
  const own = ${OWN_HOSTS.toString()};
  // A result anchor's innerText is "SiteName / breadcrumb › path / actual title" on separate lines.
  // The last line is the title; the earlier ones are chrome that would otherwise be fed to the model
  // as part of it. No class names involved, so a redesign degrades this to "whole text", not to junk.
  const titleOf = a => {
    const lines = (a.innerText || '').split('\\n').map(clean).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  };
  // The container repeats the anchor's own text before the description; removing it stops every
  // snippet from opening with a copy of the title it sits under.
  const snippetFor = (a, title) => {
    const anchorText = clean(a.innerText || '');
    let node = a.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      // Stop before climbing into a container that groups several results, or the snippet picks up
      // the *next* result's title. A block holding many links is a group, not one result's body.
      if (node.querySelectorAll('a[href]').length > 3) break;
      const full = clean(node.innerText || '');
      if (full.length <= anchorText.length + 40) continue;
      const body = clean(full.split(anchorText).join(' ').split(title).join(' '));
      if (body.length >= 20) return body.slice(0, 300);
    }
    return '';
  };
  const seen = new Set();
  const perHost = new Map();
  const results = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (results.length >= ${maxResults}) break;
    if (!visible(a)) continue;
    const title = titleOf(a);
    if (title.length < 8) continue;
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (own.test(u.hostname)) continue;
    const key = u.hostname + u.pathname;
    if (seen.has(key)) continue;
    // A result with a nested sub-link cluster (issues, discussions) contributes a run of tightly
    // packed anchors from one host in DOM order, which crowds out every lower-ranked result. Two
    // per host keeps that from turning eight slots into one site's sitemap.
    const used = perHost.get(u.hostname) || 0;
    if (used >= 2) continue;
    perHost.set(u.hostname, used + 1);
    seen.add(key);
    results.push({ title: title.slice(0, 180), url: u.href, snippet: snippetFor(a, title) });
  }
  return JSON.stringify({
    results,
    anchors: document.querySelectorAll('a[href]').length,
    blocked: /verifying you|not a bot|unusual traffic|are you a robot|verify you are human|complete the security check|traditional captcha/i
      .test(document.body ? document.body.innerText : ''),
  });
})()`;
}

type Extracted = {
  results?: { title?: string; url?: string; snippet?: string }[];
  anchors?: number;
  blocked?: boolean;
};

// A real SERP carries dozens of links even when it matches nothing. A page with almost none is an
// interstitial — a challenge, a consent wall, an error. This is the structural half of the check on
// purpose: the phrase list above cannot be complete (the challenge that prompted it says "Verifying
// you're not a bot", which none of the obvious phrasings would have caught), so the shape of the
// page has to carry the verdict when the wording is unfamiliar.
const MIN_SERP_ANCHORS = 10;

// A bot check is a gate, not noise: it does not clear on its own, and a solve persists on the
// profile (observed on a real run — one manual solve, served normally since; #238). So on a
// challenge the provider does the one thing that can work — puts the window in front of the user
// and waits for the page to turn into a SERP — rather than retrying with backoff against a wall.
// The wait is bounded because nobody may be at the desk; past it the search fails the turn the
// way it did before, with the tab left open and raised so the check can still be completed later.
const CHALLENGE_WAIT_MS = 120_000;
const CHALLENGE_POLL_MS = 1_000;

export type CdpProviderOptions = {
  challengeWaitMs?: number;
  challengePollMs?: number;
};

export class CdpSearchProvider implements SearchProvider {
  private readonly waitMs: number;
  private readonly pollMs: number;
  // One challenge at a time. Parallel searches in a turn are all refused together, and the solve
  // is profile-wide: the first to hit it raises its own tab and waits, the rest wait on the same
  // promise and then simply reload — a second raised window would compete for the user's one solve.
  private challenge?: Promise<void>;

  constructor(
    private host: BrowserHost = new ChromeHost(),
    opts: CdpProviderOptions = {},
  ) {
    this.waitMs = opts.challengeWaitMs ?? CHALLENGE_WAIT_MS;
    this.pollMs = opts.challengePollMs ?? CHALLENGE_POLL_MS;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const max = opts.maxResults ?? 8;
    const url = SEARCH_URL + encodeURIComponent(query);
    const tab = await this.host.newTab();
    // Set when this tab is showing an unsolved check: closing it would take the challenge away
    // from the user who was just told to complete it.
    let holdOpen = false;
    try {
      await tab.navigate(url);
      let data = parseExtraction(await tab.evaluate(extractionScript(max)));

      if (interstitial(data)) {
        const owner = !this.challenge;
        if (owner) {
          this.challenge = this.awaitSolve(tab, max, opts).finally(() => {
            this.challenge = undefined;
          });
        }
        try {
          await this.challenge;
        } catch (e) {
          holdOpen = owner;
          throw e;
        }
        // The solved tab has usually landed on the SERP by itself; the reload is for the tabs that
        // waited on it, which still show the check they never got to answer.
        await tab.navigate(url);
        data = parseExtraction(await tab.evaluate(extractionScript(max)));
        // Passed the check and still walled: not a challenge any more, and not something waiting
        // longer can fix. Report it as the wall it is.
        if (interstitial(data)) throw unavailable(data);
      }

      const results: SearchResult[] = (data.results ?? [])
        .filter(r => r.url && r.url.trim().length > 0)
        .slice(0, max)
        .map(r => ({
          title: r.title ?? '',
          url: r.url as string,
          snippet: r.snippet ?? '',
          source: 'brave',
        }));
      debugLog(
        `[cdp] "${query}" -> ${results.length} result(s), ${data.anchors ?? 0} links on page`,
      );
      return results;
    } finally {
      // The tab closes even when extraction threw; leaking one per failed search would grow the
      // browser's memory for the rest of the session.
      if (!holdOpen) await tab.close();
    }
  }

  // Raise the tab and poll it until the page stops looking like an interstitial. A failed probe
  // (the page is mid-navigation after the solve, or the user closed the tab) is not a verdict;
  // the deadline is. The window goes back down only on success: on timeout it stays where the user
  // will find it, with the unsolved check on it.
  private async awaitSolve(tab: TabHandle, max: number, opts: SearchOptions): Promise<void> {
    await tab.show();
    opts.onChallenge?.('raised');
    debugLog('[cdp] bot check: window raised, waiting for the user');
    const deadline = Date.now() + this.waitMs;
    let last: Extracted | undefined;
    for (;;) {
      await sleep(this.pollMs);
      try {
        last = parseExtraction(await tab.evaluate(extractionScript(max)));
        if (!interstitial(last)) break;
      } catch {
        /* mid-navigation; keep polling */
      }
      if (Date.now() >= deadline) {
        debugLog('[cdp] bot check: not completed within the wait');
        throw unavailable(last ?? { blocked: true }, true);
      }
    }
    debugLog('[cdp] bot check cleared');
    await tab.hide();
    opts.onChallenge?.('cleared');
  }
}

// Same principle as #236: a search the harness could not serve has to say so. A CAPTCHA reported
// as an empty result set reads to the model as a bad query, and it rewords and retries against a
// wall that will refuse every variant identically.
function interstitial(data: Extracted): boolean {
  return (
    !!data.blocked || ((data.results ?? []).length === 0 && (data.anchors ?? 0) < MIN_SERP_ANCHORS)
  );
}

function unavailable(data: Extracted, timedOut = false): SearchUnavailableError {
  const message = data.blocked
    ? 'the search page served a bot check instead of results'
    : `the search page returned no result list (${data.anchors ?? 0} links on the page) — likely a challenge or interstitial`;
  // The remedy is for the user (the model cannot click a checkbox): where the check is, and that
  // one solve is enough. Only on a timeout — the other way here is a wall the check didn't explain.
  return new SearchUnavailableError(
    message,
    timedOut
      ? 'The search browser was challenged and the check was not completed in time. Its window is open on the challenge — complete the check once (it persists for that profile), then ask again.'
      : undefined,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseExtraction(raw: unknown): Extracted {
  if (typeof raw !== 'string') {
    // Runtime.evaluate returning a non-string means the page never ran our script — a navigation
    // failure or a detached target, not an answered search.
    throw new Error('the search page returned nothing to extract');
  }
  try {
    return JSON.parse(raw) as Extracted;
  } catch {
    throw new Error('could not parse results from the search page');
  }
}
