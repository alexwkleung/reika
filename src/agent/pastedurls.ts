// A URL the user pastes into the prompt is fetched by the harness before the turn starts, the same
// harness-drives-the-tool move as tools/_urls.ts — but for the opposite direction. There the model
// wrote a URL and we check it; here the user handed one over and we read it, so the content is in
// context whether or not a weak model would have thought to call `fetch_url`. It removes two
// failure modes at once: ignoring the link, and answering from a guess about what's behind it.
//
// Scope is deliberately the user's raw input only. URLs the *model* produces belong to
// tools/_urls.ts (grounding), and URLs inside an @mention'd file are file content, not a request.
//
// Not every URL in a prompt is a request to read it (#448). A three-line error, a log line, a
// commit body — each carries links nobody meant to open, and a GET on a tracking, confirm or
// unsubscribe link has already acted by the time it "reads". The fetch also lands in the user
// message, the most privileged slot there is. So the trigger is the SHAPE of the prompt, not the
// presence of a URL: a short prompt with the link at its start or end, or after a read verb, is
// the case the feature exists for and fetches unprompted; anything else is asked about first
// (the TUI's confirm dialog, cf. the skill confirm #425) or, headless, left alone.
import type { PasteFetchMode } from '../types.js';
import { extractUrl } from '../tools/fetch.js';
import { extractUrls } from '../tools/_urls.js';

// Two per prompt, matching the grounder's cap — a pasted wall of links must not fan out a wall of
// requests, and beyond two the user is better served asking for them one at a time.
const MAX_PASTED_URLS = 2;

// Tighter than the tool's 64KB payload cap. This content lands in the *user message*, which the
// fit-to-window payload cap in toolcall.ts doesn't truncate, so an unbounded page could crowd out
// the task on a small window. The model can call `fetch_url` for the rest.
const MAX_PASTED_URL_CHARS = 8000;

// ---- Shape gate (#448): is the URL what the prompt is about? ----------------------------------
// One-directional like the skill gate: a wrong `true` is an outbound request nobody meant, a wrong
// `false` is one keystroke in the confirm dialog. So it under-fetches.

// Non-URL words. A request is short; a pasted error that happens to contain a link runs long.
const REQUEST_MAX_WORDS = 20;
// Verbs a URL follows when the prompt is about reading it. Not prepositions ("the error from
// https://…" is the incidental shape), not "GET"/"POST" (a log line's shape), and not "see" —
// "see https://… for details" is how an error message ends.
const READ_VERBS = [
  'read',
  'fetch',
  'look at',
  'check',
  'check out',
  'open',
  'summarize',
  'summarise',
  'review',
  'visit',
  'explain',
  'describe',
  'compare',
  'follow',
  'implement',
  'use',
  'what does',
  "what's at",
  "what's on",
  'what is at',
  'what is on',
];
// Words allowed between the verb and the URL: "read this link https://…", "summarize the page at".
const VERB_FILLERS = new Set([
  'this',
  'that',
  'the',
  'link',
  'page',
  'url',
  'site',
  'article',
  'doc',
  'docs',
  'issue',
  'pr',
  'at',
  'from',
  'on',
  'of',
  'in',
]);
// Stripped from the head before the "URL at the start" test and from the tail before the "URL at
// the end" test: "please https://… " and "https://… please" are the URL alone.
const LEAD_RE = /^(?:(?:ok|okay|hey|hi|please|pls|can you|could you|would you)\b\s*[,:]?\s*)*$/;
const TAIL_RE = /^(?:[\s.,;:!?)\]'"`>]|please|pls|thanks|thx|ty)*$/;
// What may join two URLs that are the whole prompt: "https://a and https://b".
const JOINER_RE = /\b(?:and|or|vs|plus|then)\b|&/g;

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function isUrlTheRequest(input: string, url: string): boolean {
  const at = input.indexOf(url);
  if (at < 0) return false;
  const rest = extractUrls(input)
    .reduce((s, u) => s.replaceAll(u, ' '), input)
    .toLowerCase();
  if (wordCount(rest) > REQUEST_MAX_WORDS) return false;
  // Nothing but links (and what joins them): the links are the prompt.
  const joined = rest.replace(JOINER_RE, ' ').trim();
  if (LEAD_RE.test(joined) || TAIL_RE.test(joined)) return true;
  const before = input.slice(0, at).toLowerCase();
  const after = input.slice(at + url.length).toLowerCase();
  // Positional rules want a one-line prompt: a pasted log is lines, and a link on the last one
  // is the unsubscribe-at-the-bottom shape, not a request.
  const oneLine = !input.trim().includes('\n');
  if (oneLine && LEAD_RE.test(before.trim())) return true;
  if (oneLine && TAIL_RE.test(after)) return true;
  // The verb rule reads the URL's own line only: a verb two lines up is not about this link.
  // Fillers come off one at a time, checking at each step, so "look at" survives its own "at".
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const words = line
    .replace(/[:\-–—,]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (;;) {
    const tail = words.join(' ');
    if (READ_VERBS.some(v => tail === v || tail.endsWith(` ${v}`))) return true;
    if (words.length === 0 || !VERB_FILLERS.has(words[words.length - 1])) return false;
    words.pop();
  }
}

// A URL carrying credentials (`https://user:pass@host/…`) is never auto-fetched: the receipt a
// fetch leaves would print the secret into the scrollback, and nothing a prompt can say makes a
// harness-driven request with someone's password the right move. Named by host only.
function credentialedHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.username || u.password ? u.host : undefined;
  } catch {
    return undefined;
  }
}

export type PastedUrlPlan = {
  // The fetch candidates: the first MAX_PASTED_URLS found, minus any carrying credentials.
  urls: string[];
  // Every candidate cleared the shape gate — the prompt is about reading them.
  request: boolean;
  // Hosts of the credentialed URLs left out, for the receipt.
  refused: string[];
  found: number;
};

export function planPastedUrls(input: string): PastedUrlPlan {
  const all = extractUrls(input);
  const refused: string[] = [];
  const urls: string[] = [];
  for (const url of all.slice(0, MAX_PASTED_URLS)) {
    const host = credentialedHost(url);
    if (host) refused.push(host);
    else urls.push(url);
  }
  return {
    urls,
    request: urls.length > 0 && urls.every(u => isUrlTheRequest(input, u)),
    refused,
    found: all.length,
  };
}

export type PastedUrlNotice = { text: string; tone: 'info' | 'warn' };

export type PastedUrlExpansion = {
  // Blocks to prepend to the model-facing text, structurally identical to the `<file>` blocks a
  // mention produces. Empty when nothing was fetched.
  blocks: string[];
  // Receipts for the scrollback. A network request made on the user's behalf is exactly the
  // must-see signal the persistent-vs-ephemeral rule covers.
  notices: PastedUrlNotice[];
  fetched: string[];
};

const EMPTY: PastedUrlExpansion = { blocks: [], notices: [], fetched: [] };

export async function expandPastedUrls(
  input: string,
  opts: {
    mode: PasteFetchMode;
    // The confirm dialog's answer when the URLs did not clear the shape gate: true to fetch them
    // anyway, false to leave them. Undefined when nobody was asked — the gate cleared, or headless
    // — in which case 'apply' fetches and 'ask' leaves them with a receipt saying so.
    incidental?: boolean;
    // Fired once with how many URLs are about to be fetched, before the requests go out — the
    // submit blocks on a network round trip here, and an unnarrated wait reads as a frozen TUI.
    // Reports the count only; the caller owns the wording.
    onStart?: (count: number) => void;
  },
): Promise<PastedUrlExpansion> {
  if (opts.mode === 'off') return EMPTY;
  const plan = planPastedUrls(input);
  if (plan.found === 0) return EMPTY;

  const notices: PastedUrlNotice[] = plan.refused.map(host => ({
    text: `Skipped a pasted link with credentials in it (${host}) — never fetched automatically.`,
    tone: 'warn',
  }));
  const { urls } = plan;
  if (urls.length === 0) return { blocks: [], notices, fetched: [] };

  const confirmed = opts.incidental === true;
  const fetching =
    plan.request || confirmed || (opts.incidental === undefined && opts.mode === 'apply');
  if (!fetching) {
    // A decline in the dialog needs no line — the dialog was the line. Headless under 'ask' has
    // nobody to ask, so the receipt names the way to get the fetch.
    if (opts.incidental === undefined) {
      notices.push({
        text: `Pasted link${urls.length > 1 ? 's' : ''} not fetched — the prompt doesn't read as a request to open ${urls.length > 1 ? 'them' : 'it'} (REIKA_PASTE_FETCH=apply fetches anyway).`,
        tone: 'info',
      });
    }
    return { blocks: [], notices, fetched: [] };
  }

  opts.onStart?.(urls.length);
  // allowPrivate: the host policy exists to stop the model and the harness from reaching loopback
  // and LAN addresses off attacker-influenced text (tools/_hosts.ts). A URL the user is asking
  // about is a request, and "why is http://localhost:3000 500ing" is the ordinary case it would
  // otherwise break for no gain — but the provenance of a link inside a pasted log line is the
  // log, so an incidental URL keeps the policy unless a human confirmed the fetch.
  const allowPrivate = plan.request || confirmed;
  const results = await Promise.all(urls.map(url => extractUrl(url, { allowPrivate })));

  const blocks: string[] = [];
  const fetched: string[] = [];
  for (const [i, res] of results.entries()) {
    const url = urls[i];
    if (!res.ok) {
      // `reached` separates a server that answered with an error from a request that got no
      // response — the same distinction the grounder makes, and the difference between "that link
      // is dead" and "you're offline".
      notices.push({
        text: res.reached
          ? `Couldn't fetch ${url} — ${res.error}`
          : `Couldn't reach ${url} — ${res.error}`,
        tone: 'warn',
      });
      continue;
    }
    const content = res.content.slice(0, MAX_PASTED_URL_CHARS);
    const truncated = res.content.length > MAX_PASTED_URL_CHARS;
    blocks.push(
      `<url href="${url}">\n${content || '(no extractable content)'}${
        truncated ? '\n…(truncated — call fetch_url for the full page)' : ''
      }\n</url>`,
    );
    fetched.push(url);
    notices.push({
      text: `Fetched ${url} (${res.extractedChars} chars extracted)`,
      tone: 'info',
    });
  }
  if (plan.found > MAX_PASTED_URLS) {
    notices.push({
      text: `Only the first ${MAX_PASTED_URLS} pasted URLs were fetched (${plan.found} found).`,
      tone: 'warn',
    });
  }
  return { blocks, notices, fetched };
}
