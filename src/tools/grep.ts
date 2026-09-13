import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Ignore } from 'ignore';
import type { Tool } from '../types.js';
import { resolveUserPath } from './_paths.js';
import { isFilteredTarget, shouldSkipDir } from './_walk.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import { recordCapped } from './_spillstats.js';

const MAX_MATCHES = 100;
// Ceiling on matches collected when spilling (REIKA_SPILL). Without it the walk stops dead at
// MAX_MATCHES, so there is no "rest" to save and the count in the summary is a floor, not a total.
// The extra scanning is the real cost, and it is asymmetric: glob's spill is free (the crawl
// already holds every path) while this one is paid on EVERY search broad enough to blow past the
// inline page, whether or not the model ever opens the artifact — which eval runs put at roughly
// one time in three when a shell is available to reformulate instead. 3x the page for 3x the scan
// is the trade that survives that hit rate; 10x was not.
const SPILL_MAX_MATCHES = 300;
const MAX_FILE_BYTES = 1_000_000;
const LINE_TRUNC = 300;
const CONTEXT = 2; // lines of surrounding context emitted above/below each match
const NULL_BYTE_RE = /\x00/;

type GrepState = {
  count: number;
  out: string[];
  scanned: number;
  excluded: number;
  limit: number;
  // Where the inline page ends in `out`, and how many matches it holds — set once the emitted
  // count first crosses MAX_MATCHES, at a range boundary so a match's context block is never
  // cut in half. Undefined means everything collected fits inline.
  inlineEnd?: number;
  inlineCount?: number;
};

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
      include: { type: 'string', description: 'Optional filename filter, e.g. ".ts" or "*.ts".' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern);
    const startPath = String(args.path ?? '.');
    const include = args.include ? String(args.include) : undefined;
    // Models often send glob-style filters ("*.css", "**/*.css"); reduce to the
    // suffix after the last '*' so they behave the same as a plain ".css".
    const suffix = include ? include.slice(include.lastIndexOf('*') + 1) : undefined;
    let re: RegExp;
    let preRe: RegExp;
    try {
      re = new RegExp(pattern);
      preRe = new RegExp(pattern, 'm');
    } catch (e) {
      return { summary: `Invalid regex: ${(e as Error).message}` };
    }
    const start = resolveUserPath(ctx.cwd, startPath);
    const st = await stat(start).catch(() => null);
    if (!st) return { summary: `Grep failed: path not found: ${startPath}` };
    // Same explicit-target rule as `list`: a grep aimed straight at an ignored path (build output,
    // a sibling repo) should search it instead of reporting a silent 0 matches. See _walk.ts.
    const ig = isFilteredTarget(ctx.cwd, start, ctx.ignore) ? undefined : ctx.ignore;
    const spilling = spillEnabled();
    const state: GrepState = {
      count: 0,
      out: [],
      scanned: 0,
      excluded: 0,
      limit: spilling ? SPILL_MAX_MATCHES : MAX_MATCHES,
    };
    await walk(start, ctx.cwd, ig, suffix, re, preRe, state);
    if (state.count === 0 && suffix && state.scanned === 0 && state.excluded > 0) {
      return {
        summary:
          `Found 0 matches — include "${include}" matched none of the ` +
          `${state.excluded} file(s) under ${startPath}`,
      };
    }
    const atCeiling = state.count >= state.limit;
    // Nothing was held back (or spilling is off): the ordinary result, byte-identical to the
    // pre-spill behavior so the flag is a clean A/B.
    if (!spilling || state.inlineEnd === undefined) {
      return {
        summary: `Found ${state.count}${atCeiling ? '+' : ''} matches for /${pattern}/`,
        payload: state.out.join('\n'),
      };
    }
    const shown = state.inlineCount ?? MAX_MATCHES;
    const total = `${state.count}${atCeiling ? '+' : ''}`;
    const ref = await spillResult('grep', state.out.join('\n'));
    // Recorded after the write, not before it: `spilled` has to say whether an artifact actually
    // landed, and a spill that fails (no writable tmpdir, disk full) is exactly the case the
    // stats exist to surface.
    recordCapped({ tool: 'grep', total: state.count, shown, spilled: !!ref });
    const footer = ref
      ? buildSpillFooter({ shown, total, unit: 'matches', ref })
      : buildCappedFooter({ shown, total, unit: 'matches' });
    return {
      summary: `Found ${total} matches for /${pattern}/ — showing ${shown}`,
      payload: state.out.slice(0, state.inlineEnd).join('\n') + footer,
    };
  },
};

async function walk(
  path: string,
  cwd: string,
  ig: Ignore | undefined,
  suffix: string | undefined,
  re: RegExp,
  preRe: RegExp,
  state: GrepState,
): Promise<void> {
  if (state.count >= state.limit) return;
  const st = await stat(path).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    await scanFile(path, cwd, ig, suffix, re, preRe, state);
    return;
  }
  if (!st.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (state.count >= state.limit) return;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const subPath = join(path, entry.name);
      const relSub = relative(cwd, subPath);
      if (ig && relSub.length > 0 && ig.ignores(relSub + '/')) continue;
      await walk(subPath, cwd, ig, suffix, re, preRe, state);
    } else if (entry.isFile()) {
      await scanFile(join(path, entry.name), cwd, ig, suffix, re, preRe, state);
    }
  }
}

async function scanFile(
  filePath: string,
  cwd: string,
  ig: Ignore | undefined,
  suffix: string | undefined,
  re: RegExp,
  preRe: RegExp,
  state: GrepState,
): Promise<void> {
  if (suffix && !filePath.endsWith(suffix)) {
    state.excluded++;
    return;
  }
  const relFile = relative(cwd, filePath);
  if (ig && ig.ignores(relFile)) return;
  state.scanned++;
  const st = await stat(filePath).catch(() => null);
  if (!st || st.size > MAX_FILE_BYTES) return;
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (text === null) return;
  if (NULL_BYTE_RE.test(text)) return;
  // Most files in a search hold no hit at all; one whole-text test is ~6x cheaper than splitting
  // into lines and testing each. It must be a superset of the per-line test: the `m` flag makes
  // ^/$ see line boundaries (without it `^import` would only ever match line 1). It can still
  // pass on a cross-line match (`\s` spans '\n') that no single line has — the per-line loop
  // below stays the arbiter.
  if (!preRe.test(text)) return;
  const lines = text.split('\n');

  // Collect matching line indices, respecting the global match cap.
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (state.count + hits.length >= state.limit) break;
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
    // Mark the inline cut before emitting the range that would overflow it, so the page ends on a
    // whole context block. Only consumed when spilling; harmless bookkeeping otherwise.
    if (state.inlineEnd === undefined && state.count >= MAX_MATCHES) {
      state.inlineEnd = state.out.length;
      state.inlineCount = state.count;
    }
    if (state.out.length > 0) state.out.push('--');
    const [lo, hi] = ranges[r];
    for (let i = lo; i <= hi; i++) {
      const raw = lines[i];
      const line = raw.length > LINE_TRUNC ? raw.slice(0, LINE_TRUNC) + '…' : raw;
      const isHit = hitSet.has(i);
      state.out.push(`${relFile}:${i + 1}${isHit ? ':' : '-'} ${line}`);
      if (isHit) state.count++;
    }
  }
}
