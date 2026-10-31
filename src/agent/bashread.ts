import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
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
// redirect or substitution — so anything ambiguous is not counted, never miscounted. Two shapes are
// let through by name (#810): one leading `cd <dir> &&`, and a `head -n A f | tail -n B` window. An
// lfm2.5-24b-a2b run prefixed all 213 of its bash calls with `cd <project> &&`, 117 of them reads,
// and the ladder saw none of them in 222 rounds.

// Which lines of the file the command shows, before the file's length is known. `within` is a head
// a tail was piped from: the last `last` lines of the first `within`.
export type BashReadRange = { from: number; count?: number } | { last: number; within?: number };

// `dir` is the leading `cd`'s target, which the path resolves against.
export type BashFileRead = { path: string; range: BashReadRange; dir?: string };

const CAT_FLAGS = /^-[nbsuvetAE]+$/;
const SED_PRINT_FLAG = /^-n$|^--quiet$|^--silent$/;
const SED_LINE_SCRIPT = /^(\d+)(?:,(\d+|\$))?p$/;
const HEAD_DEFAULT_LINES = 10;

export function parseBashFileRead(command: string): BashFileRead | undefined {
  const trimmed = command.trim();
  if (!trimmed || hasExecutableSubstitution(trimmed)) return undefined;
  const lead = splitLeadingCd(trimmed);
  if (!lead) return undefined;
  const read = parseOneRead(lead.rest);
  return read && lead.dir !== undefined ? { ...read, dir: lead.dir } : read;
}

// One `cd <dir> &&` hop with a literal target. Joined by `;` the read runs even when the cd failed,
// so the path would resolve against the wrong directory; a second hop is left to the separator rule.
function splitLeadingCd(command: string): { dir?: string; rest: string } | undefined {
  if (!/^cd\s/.test(command)) return { rest: command };
  const masked = maskQuoted(command);
  const at = masked.indexOf('&&');
  if (at < 0 || /[;&|<>\r\n]/.test(masked.slice(0, at))) return undefined;
  const hop = words(command.slice(0, at));
  if (hop.length !== 2 || hop[1] === '-' || /[$`]/.test(hop[1])) return undefined;
  return { dir: hop[1], rest: command.slice(at + 2).trim() };
}

function parseOneRead(command: string): BashFileRead | undefined {
  const masked = maskQuoted(command);
  const pipe = masked.indexOf('|');
  if (pipe >= 0) {
    if (/[;&|<>\r\n]/.test(masked.slice(0, pipe) + masked.slice(pipe + 1))) return undefined;
    return parseHeadTailWindow(command.slice(0, pipe), command.slice(pipe + 1));
  }
  if (/[;&<>\r\n]/.test(masked)) return undefined;
  const [name, ...args] = words(command);
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
  const parsed = parseLineCount(args);
  if (!parsed || parsed.files.length !== 1) return undefined;
  const { n, plus, files } = parsed;
  const path = files[0];
  if (name === 'head') return plus ? undefined : { path, range: { from: 1, count: n } };
  return { path, range: plus ? { from: n } : { last: n } };
}

// `head -n A f | tail -n B`, the slice a model pages a region with when it has no `sed -n`.
function parseHeadTailWindow(left: string, right: string): BashFileRead | undefined {
  const [headName, ...headArgs] = words(left);
  const [tailName, ...tailArgs] = words(right);
  if (headName !== 'head' || tailName !== 'tail') return undefined;
  const head = parseLineCount(headArgs);
  const tail = parseLineCount(tailArgs);
  if (!head || !tail || head.plus || tail.plus) return undefined;
  if (head.files.length !== 1 || tail.files.length !== 0) return undefined;
  return { path: head.files[0], range: { last: tail.n, within: head.n } };
}

function parseLineCount(args: string[]): { n: number; plus: boolean; files: string[] } | undefined {
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
  return n < 1 ? undefined : { n, plus, files };
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

// A path spelled in another case on a case-insensitive disk (`cd /repo/WT && cat a.ts`, observed)
// escapes the project by string; the real paths file it under the key `read` uses.
async function traceKey(cwd: string, full: string): Promise<string> {
  const key = traceReadPath(cwd, full);
  if (!isAbsolute(key)) return key;
  try {
    const real = traceReadPath(await realpath(cwd), await realpath(full));
    return isAbsolute(real) ? key : real;
  } catch {
    return key;
  }
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
  const full = resolveUserPath(
    parsed.dir === undefined ? cwd : resolveUserPath(cwd, parsed.dir),
    parsed.path,
  );
  try {
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_TRACED_BYTES) return undefined;
    const text = await readFile(full, 'utf8');
    const hash = createHash('sha1').update(text).digest('hex');
    const path = await traceKey(cwd, full);
    const r = parsed.range;
    if ('last' in r) {
      const lines = text.split('\n');
      const length = lines.length > 1 && lines.at(-1) === '' ? lines.length - 1 : lines.length;
      const total = r.within === undefined ? length : Math.min(length, r.within);
      return { path, offset: Math.max(1, total - r.last + 1), limit: r.last, hash };
    }
    return { path, offset: r.from, limit: r.count, hash };
  } catch {
    return undefined;
  }
}
