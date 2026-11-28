import { debugLog } from '../debug.js';
import { ChromeHost, type BrowserHost, type TabHandle } from './_chrome.js';
import { ENGINE_ORDER, type SearchEngine } from './engines.js';
import { collectScript, pickResults, type PageRecord } from './extract.js';
import { SearchUnavailableError } from './types.js';
import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

export { DATE_LINE } from './extract.js';

// Bot-check wording any engine might use, beside each engine's own (`engines.ts`). The list cannot
// be complete (the challenge that prompted it says "Verifying you're not a bot", which none of the
// obvious phrasings would have caught), so a page's shape carries the verdict too: see
// `SearchEngine.minAnchors`.
const SHARED_CHALLENGE_TEXT =
  /not a bot|unusual traffic|are you a robot|verify you are human|complete the security check/i;

// Fewer usable results than this from one engine, and the next engine is asked too (#1130). An
// engine whose page changed does not fail: it answers with one footer link, which only a count
// can tell from a real answer.
const MIN_USABLE_RESULTS = 3;

// A bot check is a gate, not noise: it does not clear on its own, and a solve persists on the
// profile (observed on a real run — one manual solve, served normally since; #238). So on a
// challenge the provider does the one thing that can work — puts the window in front of the user
// and waits for the page to turn into results — rather than retrying with backoff against a wall.
// It does so only when no other engine answered well enough: a challenge another engine can route
// around is not worth interrupting the user for. The wait is bounded because nobody may be at the
// desk; past it the search fails the way it did before, with the tab left open and raised so the
// check can still be completed later.
const CHALLENGE_WAIT_MS = 120_000;
const CHALLENGE_POLL_MS = 1_000;

export type CdpProviderOptions = {
  challengeWaitMs?: number;
  challengePollMs?: number;
  engines?: readonly SearchEngine[];
};

type EngineAnswer = SearchResult[] | 'challenged';

export class CdpSearchProvider implements SearchProvider {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly engines: readonly SearchEngine[];
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
    this.engines = opts.engines ?? ENGINE_ORDER;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const max = opts.maxResults ?? 8;
    const enough = Math.min(max, MIN_USABLE_RESULTS);
    let results: SearchResult[] = [];
    let challenged: SearchEngine | undefined;
    let failure: unknown;
    for (const engine of this.engines) {
      try {
        const answer = await this.searchEngine(engine, query, max, opts, false);
        if (answer === 'challenged') challenged ??= engine;
        else results = mergeResults(results, answer, max);
      } catch (e) {
        failure ??= e;
      }
      if (results.length >= enough) return results;
    }
    if (challenged) {
      try {
        const answer = await this.searchEngine(challenged, query, max, opts, true);
        // The challenged engine was asked first for a reason, so its results lead once it answers.
        if (answer !== 'challenged') results = mergeResults(answer, results, max);
      } catch (e) {
        // A refused search must not read as an empty one (#236), but a partial answer from another
        // engine is neither: it is what the turn has, and the challenge stays open for later.
        if (results.length === 0) throw e;
        debugLog(
          `[cdp] ${challenged.name}: check not completed, keeping the other engines' results`,
        );
      }
      return results;
    }
    if (results.length === 0 && failure) throw failure;
    return results;
  }

  private async searchEngine(
    engine: SearchEngine,
    query: string,
    max: number,
    opts: SearchOptions,
    allowChallenge: boolean,
  ): Promise<EngineAnswer> {
    const url = engine.searchUrl(query);
    const tab = await this.host.newTab();
    // Set when this tab is showing an unsolved check: closing it would take the challenge away
    // from the user who was just told to complete it.
    let holdOpen = false;
    try {
      await tab.navigate(url);
      let page = parsePage(await tab.evaluate(collectScript()));
      let picked = pickResults(page, engine, max);

      if (interstitial(engine, page, picked.length)) {
        if (!allowChallenge) {
          debugLog(`[cdp] ${engine.name} "${query}" -> challenge, trying the next engine`);
          return 'challenged';
        }
        const owner = !this.challenge;
        if (owner) {
          this.challenge = this.awaitSolve(tab, engine, max, opts).finally(() => {
            this.challenge = undefined;
          });
        }
        try {
          await this.challenge;
        } catch (e) {
          holdOpen = owner;
          throw e;
        }
        // The solved tab has usually landed on the results by itself; the reload is for the tabs
        // that waited on it, which still show the check they never got to answer.
        await tab.navigate(url);
        page = parsePage(await tab.evaluate(collectScript()));
        picked = pickResults(page, engine, max);
        // Passed the check and still walled: not a challenge any more, and not something waiting
        // longer can fix. Report it as the wall it is.
        if (interstitial(engine, page, picked.length)) throw unavailable(engine, page);
      }

      debugLog(
        `[cdp] ${engine.name} "${query}" -> ${picked.length} result(s), ${page.anchors} links on page`,
      );
      return picked.map(r => ({ ...r, source: engine.name }));
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
  private async awaitSolve(
    tab: TabHandle,
    engine: SearchEngine,
    max: number,
    opts: SearchOptions,
  ): Promise<void> {
    await tab.show();
    opts.onChallenge?.('raised');
    debugLog(`[cdp] ${engine.name} bot check: window raised, waiting for the user`);
    const deadline = Date.now() + this.waitMs;
    let last: PageRecord | undefined;
    for (;;) {
      await sleep(this.pollMs);
      try {
        last = parsePage(await tab.evaluate(collectScript()));
        if (!interstitial(engine, last, pickResults(last, engine, max).length)) break;
      } catch {
        /* mid-navigation; keep polling */
      }
      if (Date.now() >= deadline) {
        debugLog(`[cdp] ${engine.name} bot check: not completed within the wait`);
        throw unavailable(engine, last, true);
      }
    }
    debugLog(`[cdp] ${engine.name} bot check cleared`);
    await tab.hide();
    opts.onChallenge?.('cleared');
  }
}

// Earlier results first, a later engine's only where they add a page not already listed.
function mergeResults(first: SearchResult[], then: SearchResult[], max: number): SearchResult[] {
  const seen = new Set(first.map(r => r.url));
  const out = [...first];
  for (const r of then) {
    if (out.length >= max) break;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out.slice(0, max);
}

function challengeText(engine: SearchEngine, page: PageRecord): boolean {
  return SHARED_CHALLENGE_TEXT.test(page.bodyText) || engine.challengeText.test(page.bodyText);
}

// Same principle as #236: a search the harness could not serve has to say so. A CAPTCHA reported
// as an empty result set reads to the model as a bad query, and it rewords and retries against a
// wall that will refuse every variant identically. The wording counts only while the page offers
// too little to use, so a result whose snippet quotes "unusual traffic" does not read as a wall.
function interstitial(engine: SearchEngine, page: PageRecord, picked: number): boolean {
  if (picked < MIN_USABLE_RESULTS && challengeText(engine, page)) return true;
  return picked === 0 && page.anchors < engine.minAnchors;
}

function unavailable(
  engine: SearchEngine,
  page: PageRecord | undefined,
  timedOut = false,
): SearchUnavailableError {
  const message =
    !page || challengeText(engine, page)
      ? `the ${engine.name} search page served a bot check instead of results`
      : `the ${engine.name} search page returned no result list (${page.anchors} links on the page) — likely a challenge or interstitial`;
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

function parsePage(raw: unknown): PageRecord {
  if (typeof raw !== 'string') {
    // Runtime.evaluate returning a non-string means the page never ran our script — a navigation
    // failure or a detached target, not an answered search.
    throw new Error('the search page returned nothing to extract');
  }
  let page: Partial<PageRecord>;
  try {
    page = JSON.parse(raw) as Partial<PageRecord>;
  } catch {
    throw new Error('could not parse results from the search page');
  }
  return {
    links: Array.isArray(page.links) ? page.links : [],
    anchors: typeof page.anchors === 'number' ? page.anchors : 0,
    bodyText: typeof page.bodyText === 'string' ? page.bodyText : '',
  };
}
