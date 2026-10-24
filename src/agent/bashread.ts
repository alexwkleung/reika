import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { resolveUserPath } from '../tools/_paths.js';
import { hasExecutableSubstitution, maskQuoted, words } from '../tools/_readonly.js';

// File reads through `bash` (#801). ReadTrace's coverage depth (#341) saw only the `read` tool, so
// a model that reads through the shell was invisible to the loop ladder: an lfm2.5-24b-a2b run
// made 159 bash calls and 5 reads in 164 rounds, `cat`-ing one unchanged 102-line file ~15 times
// with no edit, and nothing fired. A plain one-file read is recognized here and recorded like a
// `read`, so it deepens the same per-file count.
//
// One-directional: only a single command reading a single file counts — no pipe, separator,
// redirect or substitution — so anything ambiguous is not counted, never miscounted.

// Which lines of the file the command shows, before the file's length is known.
export type BashReadRange = { from: number; count?: number } | { last: number };

export type BashFileRead = { path: string; range: BashReadRange };

const CAT_FLAGS = /^-[nbsuvetAE]+$/;
const SED_PRINT_FLAG = /^-n$|^--quiet$|^--silent$/;
const SED_LINE_SCRIPT = /^(\d+)(?:,(\d+|\$))?p$/;
const HEAD_DEFAULT_LINES = 10;

export function parseBashFileRead(command: string): BashFileRead | undefined {
  const trimmed = command.trim();
  if (!trimmed || hasExecutableSubstitution(trimmed)) return undefined;
  if (/[;&|<>\r\n]/.test(maskQuoted(trimmed))) return undefined;
  const [name, ...args] = words(trimmed);
  if (name === 'cat') {
    const files = args.filter(a => !CAT_FLAGS.test(a));
    if (files.length !== 1 || files[0].startsWith('-')) return undefined;
    return { path: files[0], range: { from: 1 } };
  }
  if (name === 'head' || name === 'tail') return parseHeadTail(name, args);
  if (name === 'sed') return parseSedPrint(args);
  return undefined;
}

function parseHeadTail(name: 'head' | 'tail', args: string[]): BashFileRead | undefined {
  let n = HEAD_DEFAULT_LINES;
  let plus = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let value: string | undefined;
    if (a === '-n' || a === '--lines') value = args[++i];
    else if (a.startsWith('--lines=')) value = a.slice('--lines='.length);
    else if (/^-n.+/.test(a)) value = a.slice(2);
    else if (/^-\d+$/.test(a)) value = a.slice(1);
    else if (a.startsWith('-')) return undefined;
    else {
      files.push(a);
      continue;
    }
    const m = value?.match(/^(\+)?(\d+)$/);
    if (!m) return undefined;
    plus = !!m[1];
    n = Number(m[2]);
  }
  if (files.length !== 1 || n < 1) return undefined;
  const path = files[0];
  if (name === 'head') return plus ? undefined : { path, range: { from: 1, count: n } };
  return { path, range: plus ? { from: n } : { last: n } };
}

function parseSedPrint(args: string[]): BashFileRead | undefined {
  if (args.length !== 3 || !SED_PRINT_FLAG.test(args[0])) return undefined;
  const m = args[1].match(SED_LINE_SCRIPT);
  const path = args[2];
  if (!m || path.startsWith('-')) return undefined;
  const from = Number(m[1]);
  if (from < 1) return undefined;
  if (m[2] === undefined) return { path, range: { from, count: 1 } };
  if (m[2] === '$') return { path, range: { from } };
  const to = Number(m[2]);
  return to >= from ? { path, range: { from, count: to - from + 1 } } : undefined;
}

// The key ReadTrace files a path under: project-relative when inside the project, so `read src/a.ts`
// and `cat /repo/src/a.ts` deepen one file rather than two.
export function traceReadPath(cwd: string, path: string): string {
  const full = resolveUserPath(cwd, path);
  const rel = relative(cwd, full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : full;
}

// A file larger than this is not hashed: a cat of it is not the re-read loop this tracks.
const MAX_TRACED_BYTES = 2 * 1024 * 1024;

// What ReadTrace.record needs for a successful shell read, or undefined when the command is not a
// plain one-file read or the file cannot be read now. Hashed exactly as `read` hashes, so the two
// share one file entry and an edit in between resets it.
export async function traceBashRead(
  command: string,
  cwd: string,
): Promise<{ path: string; offset: number; limit?: number; hash: string } | undefined> {
  const parsed = parseBashFileRead(command);
  if (!parsed) return undefined;
  const full = resolveUserPath(cwd, parsed.path);
  try {
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_TRACED_BYTES) return undefined;
    const text = await readFile(full, 'utf8');
    const hash = createHash('sha1').update(text).digest('hex');
    const path = traceReadPath(cwd, parsed.path);
    const r = parsed.range;
    if ('last' in r) {
      const lines = text.split('\n');
      const total = lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length;
      return { path, offset: Math.max(1, total - r.last + 1), limit: r.last, hash };
    }
    return { path, offset: r.from, limit: r.count, hash };
  } catch {
    return undefined;
  }
}
