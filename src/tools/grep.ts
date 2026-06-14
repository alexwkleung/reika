import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { Ignore } from 'ignore';
import type { Tool } from '../types.js';
import { shouldSkipDir } from './_walk.js';

const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1_000_000;
const LINE_TRUNC = 300;
const CONTEXT = 2; // lines of surrounding context emitted above/below each match
const NULL_BYTE_RE = /\x00/;

type GrepState = { count: number; out: string[] };

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regex. Returns up to 100 matches, each with a few ' +
    'lines of surrounding context so you can read the body without a follow-up call (match lines ' +
    'are prefixed `path:line:`, context lines `path:line-`). Refine pattern or scope if truncated.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (JavaScript syntax).' },
      path: { type: 'string', description: 'Directory or file to search. Default cwd.' },
      include: { type: 'string', description: 'Optional filename suffix filter, e.g. ".ts".' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern);
    const startPath = String(args.path ?? '.');
    const include = args.include ? String(args.include) : undefined;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { summary: `Invalid regex: ${(e as Error).message}` };
    }
    const start = resolve(ctx.cwd, startPath);
    const state: GrepState = { count: 0, out: [] };
    await walk(start, ctx.cwd, ctx.ignore, include, re, state);
    const truncated = state.count >= MAX_MATCHES;
    return {
      summary: `Found ${state.count}${truncated ? '+' : ''} matches for /${pattern}/`,
      payload: state.out.join('\n'),
    };
  },
};

async function walk(
  path: string,
  cwd: string,
  ig: Ignore | undefined,
  include: string | undefined,
  re: RegExp,
  state: GrepState,
): Promise<void> {
  if (state.count >= MAX_MATCHES) return;
  const st = await stat(path).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    await scanFile(path, cwd, ig, include, re, state);
    return;
  }
  if (!st.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (state.count >= MAX_MATCHES) return;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const subPath = join(path, entry.name);
      const relSub = relative(cwd, subPath);
      if (ig && relSub.length > 0 && ig.ignores(relSub + '/')) continue;
      await walk(subPath, cwd, ig, include, re, state);
    } else if (entry.isFile()) {
      await scanFile(join(path, entry.name), cwd, ig, include, re, state);
    }
  }
}

async function scanFile(
  filePath: string,
  cwd: string,
  ig: Ignore | undefined,
  include: string | undefined,
  re: RegExp,
  state: GrepState,
): Promise<void> {
  if (include && !filePath.endsWith(include)) return;
  const relFile = relative(cwd, filePath);
  if (ig && ig.ignores(relFile)) return;
  const st = await stat(filePath).catch(() => null);
  if (!st || st.size > MAX_FILE_BYTES) return;
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (text === null) return;
  if (NULL_BYTE_RE.test(text)) return;
  const lines = text.split('\n');

  // Collect matching line indices, respecting the global match cap.
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (state.count + hits.length >= MAX_MATCHES) break;
    if (re.test(lines[i])) hits.push(i);
  }
  if (hits.length === 0) return;

  // Merge each match's ±CONTEXT window into non-overlapping ranges so adjacent
  // matches share one block instead of repeating lines.
  const ranges: Array<[number, number]> = [];
  for (const idx of hits) {
    const lo = Math.max(0, idx - CONTEXT);
    const hi = Math.min(lines.length - 1, idx + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  const hitSet = new Set(hits);
  for (let r = 0; r < ranges.length; r++) {
    if (state.out.length > 0) state.out.push('--');
    const [lo, hi] = ranges[r];
    for (let i = lo; i <= hi; i++) {
      const raw = lines[i];
      const line = raw.length > LINE_TRUNC ? raw.slice(0, LINE_TRUNC) + '…' : raw;
      const sep = hitSet.has(i) ? ':' : '-';
      state.out.push(`${relFile}:${i + 1}${sep} ${line}`);
    }
  }
  state.count += hits.length;
}
