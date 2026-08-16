// Glob tool — find files by path pattern (no content reading).
import { fdir } from 'fdir';
import picomatch from 'picomatch';
import { relative } from 'node:path';
import { resolveUserPath } from './_paths.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import type { Tool } from '../types.js';

const MAX_MATCHES = 200;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "**/*.ts", "src/agent/**", "**/*.test.*"). Returns paths only — no file contents. Pair with read or grep when you need the actual content. Respects .gitignore.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern. Supports ** (any depth) and * (any filename chars).',
      },
      path: {
        type: 'string',
        description: 'Base directory to glob from, relative to cwd. Default cwd.',
      },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return { summary: 'Glob failed: empty pattern' };
    const startPath = String(args.path ?? '.');
    const start = resolveUserPath(ctx.cwd, startPath);
    const ig = ctx.ignore;

    let isMatch: (path: string) => boolean;
    try {
      isMatch = picomatch(pattern, { dot: false });
    } catch (e) {
      return { summary: `Glob failed: invalid pattern (${(e as Error).message})` };
    }

    const crawler = new fdir()
      .withRelativePaths()
      .exclude((dirName, dirPath) => {
        if (dirName.startsWith('.') || SKIP_DIRS.has(dirName)) return true;
        const rel = relative(ctx.cwd, dirPath);
        return ig != null && rel.length > 0 && ig.ignores(rel + '/');
      })
      .filter(relPath => {
        if (ig?.ignores(relPath)) return false;
        return isMatch(relPath);
      })
      .crawl(start);

    const files = (await crawler.withPromise()) as string[];
    files.sort();
    const truncated = files.length > MAX_MATCHES;
    // Off, or nothing held back: byte-identical to the pre-spill behavior so the flag is a clean A/B.
    if (!spillEnabled() || !truncated) {
      return {
        summary: `Found ${files.length}${truncated ? '+' : ''} file(s) matching ${pattern}`,
        payload: files.slice(0, MAX_MATCHES).join('\n') || '(no matches)',
      };
    }
    // The crawl already holds every match, so saving the rest costs one write and no extra
    // walking. Without it the dropped tail is unrecoverable: the inline page is the *lexicographic*
    // head, so a broad pattern shows one early directory and the model reads that as the whole set.
    const ref = await spillResult('glob-results', files.join('\n'));
    const footer = ref
      ? buildSpillFooter({ shown: MAX_MATCHES, total: String(files.length), unit: 'paths', ref })
      : buildCappedFooter({ shown: MAX_MATCHES, total: String(files.length), unit: 'paths' });
    return {
      summary: `Found ${files.length} file(s) matching ${pattern} — showing ${MAX_MATCHES}`,
      payload: files.slice(0, MAX_MATCHES).join('\n') + footer,
    };
  },
};
