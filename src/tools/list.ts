import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveUserPath } from './_paths.js';
import type { Ignore } from 'ignore';
import type { Tool } from '../types.js';
import { isFilteredTarget, shouldSkipDir } from './_walk.js';

const MAX_ENTRIES = 500;

type ListState = {
  out: string[];
  // Entries dropped by .gitignore / build-dir rules. Counted so a listing that comes back empty
  // says why instead of reading as "this directory is empty".
  hidden: number;
};

export const listTool: Tool = {
  name: 'list',
  description:
    'List files in a directory. Non-recursive by default. Use depth>1 for subdirs. Skips ' +
    'gitignored and build output, unless you name such a directory yourself (e.g. path="release") ' +
    '— then its contents are listed.',
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
    const start = resolveUserPath(ctx.cwd, path);
    const st = await stat(start).catch(() => null);
    if (!st) return { summary: `List failed: path not found: ${path}` };
    // A file where a directory was expected reads as "0 entries" if we just walk it, so the model
    // concludes the path doesn't exist. Name what it actually is and point at the tool that reads it.
    if (!st.isDirectory()) {
      return {
        summary: `List failed: ${path} is a file, not a directory`,
        payload: `(${path} is a file — call read with path="${path}" for its contents, or list its parent directory)`,
      };
    }
    // The model asked for this exact path; if .gitignore is what excludes it, honor the request
    // over the ignore file (see isFilteredTarget). node_modules/dist/dot-dirs stay skipped even
    // then — the walk already starts inside the named directory, so that only ever drops a
    // nested build dir, and dropping it keeps a recursive listing from crawling a dependency tree.
    const unfiltered = isFilteredTarget(ctx.cwd, start, ctx.ignore);
    // Entries display relative to cwd for paths inside it (unchanged), and under the path the model
    // gave for anything outside — a `../../..` chain is both unreadable and dangerous to copy back.
    const relToCwd = relative(ctx.cwd, start);
    const base = relToCwd && !relToCwd.startsWith('..') ? relToCwd : path === '.' ? '' : path;
    const state: ListState = { out: [], hidden: 0 };
    await walk(start, base, unfiltered ? undefined : ctx.ignore, depth, state);
    // Name the directory the same way its entries are named, so the summary and the payload
    // can't disagree about what path the model should pass back.
    const rel = base || '.';
    const truncated = state.out.length >= MAX_ENTRIES;
    const hiddenNote =
      state.hidden > 0 ? ` (${state.hidden} hidden by .gitignore/build-dir rules)` : '';
    if (state.out.length === 0) {
      return {
        summary: `Listed 0 entries in ${rel}${hiddenNote}`,
        payload:
          state.hidden > 0
            ? `(no listable entries in ${rel} — ${state.hidden} were hidden by .gitignore or build-dir rules; call list on one of those paths directly to see inside it)`
            : `(${rel} is an empty directory)`,
      };
    }
    // The summary ages out with compaction, so the "there is more" signal has to live in the
    // payload, at the point of recency, and name the next call.
    const more = truncated
      ? `\n…(stopped at ${MAX_ENTRIES} entries — call list on a subdirectory for the rest)`
      : '';
    return {
      summary: `Listed ${state.out.length}${truncated ? '+' : ''} entries in ${rel}${hiddenNote}`,
      payload: state.out.join('\n') + more,
    };
  },
};

async function walk(
  dir: string,
  base: string,
  ig: Ignore | undefined,
  depthLeft: number,
  state: ListState,
): Promise<void> {
  if (depthLeft <= 0 || state.out.length >= MAX_ENTRIES) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (state.out.length >= MAX_ENTRIES) return;
    const relEntry = join(base, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        state.hidden++;
        continue;
      }
      if (ig && ig.ignores(relEntry + '/')) {
        state.hidden++;
        continue;
      }
      state.out.push(`${relEntry}/`);
      await walk(join(dir, entry.name), relEntry, ig, depthLeft - 1, state);
    } else if (entry.isFile()) {
      if (ig && ig.ignores(relEntry)) {
        state.hidden++;
        continue;
      }
      state.out.push(relEntry);
    }
  }
}
