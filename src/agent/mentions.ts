import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { imageBlock } from './attachments.js';
import type { OcrProvider } from '../ocr/types.js';

const MENTION_RE = /(?:^|\s)@(\S+)/g;
const MAX_MENTION_BYTES = 50_000;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

// Bare (un-@'d) image paths, so dragging a file into the terminal just works — every terminal
// that supports drop inserts a backslash-escaped path, hence the `\ ` alternative. Requiring a
// path separator is what keeps prose out: "rename logo.png" is talking about a file, while
// "/Users/me/shot.png" or "./shot.png" is handing one over.
const IMAGE_PATH_RE =
  /(?:^|\s)((?:\\ |[^\s])*\/(?:\\ |[^\s])*\.(?:png|jpe?g|gif|webp|bmp|tiff?))(?=\s|$)/gi;

export type MentionExpansion = {
  augmented: string;
  display: string;
  found: string[];
  // User-facing lines for attachments that were recognized but couldn't be read (no OCR on this
  // platform, no text in the image). A silently dropped attachment is indistinguishable from the
  // model ignoring it, so these go to the scrollback rather than nowhere.
  notices: string[];
};

export async function expandMentions(
  input: string,
  cwd: string,
  opts?: { ocr?: OcrProvider },
): Promise<MentionExpansion> {
  const mentions = collectMentions(input);
  const bareImages = collectBareImagePaths(input).filter(p => !mentions.includes(p));
  if (mentions.length === 0 && bareImages.length === 0) {
    return { augmented: input, display: input, found: [], notices: [] };
  }

  const blocks: string[] = [];
  const found: string[] = [];
  const notices: string[] = [];
  for (const mention of [...mentions, ...bareImages]) {
    const expanded = expandHome(unescapeDropped(mention));
    const full = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (IMAGE_EXTS.has(extname(full).toLowerCase())) {
      const block = await expandImageMention(full, mention, opts?.ocr, notices);
      if (block) {
        blocks.push(block);
        found.push(mention);
      }
      continue;
    }
    try {
      const raw = await readFile(full, 'utf8');
      const truncated =
        raw.length > MAX_MENTION_BYTES
          ? raw.slice(0, MAX_MENTION_BYTES) +
            `\n…(truncated, ${raw.length - MAX_MENTION_BYTES} more bytes)`
          : raw;
      blocks.push(`<file path="${mention}">\n${truncated}\n</file>`);
      found.push(mention);
    } catch {
      // unreadable mention — silently skip; user can correct or notice missing context
    }
  }

  if (blocks.length === 0) return { augmented: input, display: input, found: [], notices };
  const augmented = `${blocks.join('\n\n')}\n\n${input}`;
  return { augmented, display: input, found, notices };
}

// An image mention can't be inlined as text, so it goes through OCR. Failures are reported
// rather than swallowed: an image the user deliberately attached is not something to drop
// quietly the way an unreadable @mention is.
async function expandImageMention(
  full: string,
  mention: string,
  ocr: OcrProvider | undefined,
  notices: string[],
): Promise<string | null> {
  const label = basename(full);
  // Read before checking for a provider, so nothing that merely *looks* like an image path
  // gets a notice. The bare-path pattern happily matches `https://example.com/logo.png`;
  // that resolves to no file, and a user who pasted a URL never asked to attach anything.
  let bytes: Buffer;
  try {
    bytes = await readFile(full);
  } catch {
    return null; // missing file — same silent skip as any other unresolvable mention
  }
  if (!ocr) {
    notices.push(`Can't attach ${label} — image OCR is unavailable on this platform.`);
    return null;
  }
  const result = await ocr(bytes);
  if (!result.ok) {
    notices.push(
      result.reason === 'unavailable'
        ? `Can't attach ${label} — image OCR is unavailable on this platform.`
        : result.reason === 'no-text'
          ? `No text found in ${label}.`
          : `Couldn't read ${label}: ${result.detail ?? 'OCR failed'}`,
    );
    return null;
  }
  return imageBlock({ path: mention }, result.text);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

// Terminals escape spaces when a file is dropped onto them.
function unescapeDropped(p: string): string {
  return p.replace(/\\ /g, ' ');
}

function collectMentions(input: string): string[] {
  const out: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(input)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// Whether the text carries an image path expandMentions would pick up on its own — the
// dragged-in-file form, with no '@' in front of it. Exposed so a caller can tell that this
// text expands into an attachment without paying for the expansion.
export function hasBareImagePath(input: string): boolean {
  return collectBareImagePaths(input).length > 0;
}

function collectBareImagePaths(input: string): string[] {
  const out: string[] = [];
  IMAGE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_PATH_RE.exec(input)) !== null) {
    // An @mention matches this pattern too (the @ is just another non-space char); the
    // mention pass already owns those.
    if (!m[1].startsWith('@')) out.push(m[1]);
  }
  return out;
}
