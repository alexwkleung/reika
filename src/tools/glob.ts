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
    // The crawl already holds every match, so saving the rest costs one write and no extra walking.
    // Without it the omitted paths are unrecoverable, which is also what makes the sampled page
    // below safe: the complete sorted list survives here regardless of what the page shows.
    const ref = await spillResult('glob', files.join('\n'));
    const { page, entries, unreached } = sampleAcrossEntries(files, MAX_MATCHES);
    const note = samplingNote(entries, unreached);
    const footer = ref
      ? buildSpillFooter({
          shown: page.length,
          total: String(files.length),
          unit: 'paths',
          ref,
          note,
        })
      : buildCappedFooter({ shown: page.length, total: String(files.length), unit: 'paths', note });
    return {
      summary: `Found ${files.length} file(s) matching ${pattern} — showing ${page.length}`,
      payload: page.join('\n') + footer,
    };
  },
};

// An over-cap page is otherwise the *lexicographic* head, which is one alphabetical region of the
// tree rather than a view of it: measured on a 2300-file monorepo, `**/*.ts` matched 560 files
// whose 200-path head covered 3 of 5 top-level packages, so two were absent with nothing saying a
// region was missing rather than a tail. Slots are dealt round-robin so every entry is represented
// before any gets a second path, but the page is emitted GROUPED — allocation is round-robin,
// output is not interleaved. A page that alternates between packages line by line is harder for a
// small model to read structure from than contiguous runs, and grouping costs nothing to keep.
export function sampleAcrossEntries(
  sorted: string[],
  limit: number,
): { page: string[]; entries: number; unreached: number } {
  // `sorted` is lexicographic, so first-seen order is already sorted group order.
  const groups = new Map<string, string[]>();
  for (const p of sorted) {
    // A file sitting directly at the search root is its own entry, so root-level files each get a
    // slot rather than competing as one group.
    const slash = p.indexOf('/');
    const key = slash === -1 ? p : p.slice(0, slash + 1);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const taken = new Map<string, number>();
  let total = 0;
  let dealt = true;
  while (total < limit && dealt) {
    dealt = false;
    for (const [key, paths] of groups) {
      if (total >= limit) break;
      const n = taken.get(key) ?? 0;
      if (n >= paths.length) continue;
      taken.set(key, n + 1);
      total++;
      dealt = true;
    }
  }
  const page: string[] = [];
  for (const [key, paths] of groups) page.push(...paths.slice(0, taken.get(key) ?? 0));
  return { page, entries: groups.size, unreached: groups.size - taken.size };
}

// Says the page is a sample rather than the head, since a model cannot tell the two apart by
// looking, and points at `path` for depth — sampling trades depth in one entry for breadth, and
// re-running scoped is how the model buys it back.
function samplingNote(entries: number, unreached: number): string {
  if (unreached > 0) {
    return (
      `Sampled across ${entries - unreached} of ${entries} top-level entries (more entries than ` +
      `room); set \`path\` to one to see it properly.`
    );
  }
  return (
    `Sampled evenly across all ${entries} top-level entries, not the sorted head — ` +
    `set \`path\` to one for more depth in it.`
  );
}
