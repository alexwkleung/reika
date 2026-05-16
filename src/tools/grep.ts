import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { Ignore } from 'ignore';
import type { Tool } from '../types.js';
import { shouldSkipDir } from './_walk.js';

const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1_000_000;
const LINE_TRUNC = 300;
const NULL_BYTE_RE = /\x00/;

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regex. Returns up to 100 matches; refine pattern or scope if truncated.',
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
    const matches: string[] = [];
    await walk(start, ctx.cwd, ctx.ignore, include, re, matches);
    const truncated = matches.length >= MAX_MATCHES;
    return {
      summary: `Found ${matches.length}${truncated ? '+' : ''} matches for /${pattern}/`,
      payload: matches.join('\n'),
    };
  },
};

async function walk(
  path: string,
  cwd: string,
  ig: Ignore | undefined,
  include: string | undefined,
  re: RegExp,
  matches: string[],
): Promise<void> {
  if (matches.length >= MAX_MATCHES) return;
  const st = await stat(path).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    await scanFile(path, cwd, ig, include, re, matches);
    return;
  }
  if (!st.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) return;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const subPath = join(path, entry.name);
      const relSub = relative(cwd, subPath);
      if (ig && relSub.length > 0 && ig.ignores(relSub + '/')) continue;
      await walk(subPath, cwd, ig, include, re, matches);
    } else if (entry.isFile()) {
      await scanFile(join(path, entry.name), cwd, ig, include, re, matches);
    }
  }
}

async function scanFile(
  filePath: string,
  cwd: string,
  ig: Ignore | undefined,
  include: string | undefined,
  re: RegExp,
  matches: string[],
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
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= MAX_MATCHES) return;
    if (re.test(lines[i])) {
      const line = lines[i].length > LINE_TRUNC ? lines[i].slice(0, LINE_TRUNC) + '…' : lines[i];
      matches.push(`${relFile}:${i + 1}: ${line}`);
    }
  }
}
