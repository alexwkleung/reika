import { createHash } from 'node:crypto';

// EXPERIMENT (#1132, REIKA_EDIT_POSITION=1, default off): `edit` may take a position — an anchor
// line to insert beside, or a line range to replace — instead of exact old text. A range is checked
// against a short per-line hash the read gutter carries (`  120:a3f│…`), so a stale line number
// fails loudly the way a wrong old_string does. Off, the read gutter and the edit schema are
// byte-identical to before. Read per call, like REIKA_ASK, so a test can toggle it.
export function positionalEditsEnabled(): boolean {
  return process.env.REIKA_EDIT_POSITION === '1';
}

// Three hex chars: 1 in 4096 that a changed line keeps its hash, and a range checks both its first
// and last lines, so a stale range that slips through needs two coincidences at once. Short because
// every read pays four extra chars per line for it.
const LINE_HASH_CHARS = 3;

export function lineHash(line: string): string {
  return createHash('sha1').update(line.replace(/\r$/, '')).digest('hex').slice(0, LINE_HASH_CHARS);
}

// The `NNNNN│` gutter read, the edit echo and the failure excerpts share, with the hash between the
// number and the bar when positional edits are on. Everything after `│` is still the line verbatim.
export function gutterLine(n: number, line: string, hashed = positionalEditsEnabled()): string {
  return `${String(n).padStart(5, ' ')}${hashed ? `:${lineHash(line)}` : ''}│${line}`;
}

// Strips either gutter form, for the readers that match on a line's content.
export const GUTTER_PREFIX_RE = /^\s*\d+(?::[0-9a-f]+)?│/;

export type LineRef = { line: number; hash?: string };

// `118:a3f` as copied from the gutter, a bare `118`, or a number. A bare number parses so the
// refusal can show that line's hash rather than a schema error.
export function parseLineRef(value: unknown): LineRef | null {
  if (typeof value === 'number' && Number.isInteger(value)) return { line: value };
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d+)\s*(?::\s*([0-9a-fA-F]+))?\s*(?:│.*)?$/.exec(value);
  if (!m) return null;
  return { line: Number(m[1]), ...(m[2] ? { hash: m[2].toLowerCase() } : {}) };
}
