import { readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { Ignore } from 'ignore';
import type { Tool } from '../types.js';
import { shouldSkipDir } from './_walk.js';

const MAX_ENTRIES = 500;

export const listTool: Tool = {
  name: 'list',
  description: 'List files in a directory. Non-recursive by default. Use depth>1 for subdirs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path, relative to cwd. Default cwd.' },
      depth: { type: 'integer', description: 'Recursion depth, 1-5. Default 1.' },
    },
  },
  async run(args, ctx) {
    const path = String(args.path ?? '.');
    const depth = Math.max(1, Math.min(5, Number(args.depth ?? 1)));
    const start = resolve(ctx.cwd, path);
    const out: string[] = [];
    await walk(start, ctx.cwd, ctx.ignore, depth, out);
    const truncated = out.length >= MAX_ENTRIES;
    const rel = relative(ctx.cwd, start) || '.';
    return {
      summary: `Listed ${out.length}${truncated ? '+' : ''} entries in ${rel}`,
      payload: out.join('\n'),
    };
  },
};

async function walk(
  dir: string,
  cwd: string,
  ig: Ignore | undefined,
  depthLeft: number,
  out: string[],
): Promise<void> {
  if (depthLeft <= 0 || out.length >= MAX_ENTRIES) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const sub = join(dir, entry.name);
      const relSub = relative(cwd, sub);
      if (ig && relSub.length > 0 && ig.ignores(relSub + '/')) continue;
      out.push(`${relSub}/`);
      await walk(sub, cwd, ig, depthLeft - 1, out);
    } else if (entry.isFile()) {
      const relFile = relative(cwd, join(dir, entry.name));
      if (ig && ig.ignores(relFile)) continue;
      out.push(relFile);
    }
  }
}
