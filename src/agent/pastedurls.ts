// A URL the user pastes into the prompt is fetched by the harness before the turn starts, the same
// harness-drives-the-tool move as tools/_urls.ts — but for the opposite direction. There the model
// wrote a URL and we check it; here the user handed one over and we read it, so the content is in
// context whether or not a weak model would have thought to call `fetch_url`. It removes two
// failure modes at once: ignoring the link, and answering from a guess about what's behind it.
//
// Scope is deliberately the user's raw input only. URLs the *model* produces belong to
// tools/_urls.ts (grounding), and URLs inside an @mention'd file are file content, not a request.
import { extractUrl } from '../tools/fetch.js';
import { extractUrls } from '../tools/_urls.js';

// Two per prompt, matching the grounder's cap — a pasted wall of links must not fan out a wall of
// requests, and beyond two the user is better served asking for them one at a time.
const MAX_PASTED_URLS = 2;

// Tighter than the tool's 64KB payload cap. This content lands in the *user message*, which the
// fit-to-window payload cap in toolcall.ts doesn't truncate, so an unbounded page could crowd out
// the task on a small window. The model can call `fetch_url` for the rest.
const MAX_PASTED_URL_CHARS = 8000;

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
  opts: { enabled: boolean },
): Promise<PastedUrlExpansion> {
  if (!opts.enabled) return EMPTY;
  const all = extractUrls(input);
  if (all.length === 0) return EMPTY;

  const urls = all.slice(0, MAX_PASTED_URLS);
  const results = await Promise.all(urls.map(url => extractUrl(url)));

  const blocks: string[] = [];
  const notices: PastedUrlNotice[] = [];
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
  if (all.length > urls.length) {
    notices.push({
      text: `Only the first ${MAX_PASTED_URLS} pasted URLs were fetched (${all.length} found).`,
      tone: 'warn',
    });
  }
  return { blocks, notices, fetched };
}
