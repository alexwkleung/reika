import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { resolveUserPath } from './_paths.js';
import { createHash } from 'node:crypto';
import type { Tool } from '../types.js';

// Lines returned when the model gives no `limit`. Exported because the agent loop has to resolve
// the same window this tool does to tell a narrowing re-read from a repeat (agent/readtrace.ts):
// a default read followed by an explicit `limit` is only recognizable as narrowing if both sides
// agree on what the default was.
export const READ_DEFAULT_LIMIT = 300;

// line-ranged by default
export const readTool: Tool = {
  name: 'read',
  description: `Read lines from a file. Returns up to ${READ_DEFAULT_LIMIT} lines by default. Use offset+limit for paging.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to cwd.' },
      offset: { type: 'integer', description: 'Starting line, 1-indexed. Default 1.' },
      limit: {
        type: 'integer',
        description: `Max lines to return. Default ${READ_DEFAULT_LIMIT}.`,
      },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const path = String(args.path);
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? READ_DEFAULT_LIMIT));
    const full = resolveUserPath(ctx.cwd, path);
    const text = await readFile(full, 'utf8');
    // Hash the whole file (not the returned slice) so a window-varying re-read of the same
    // region hashes identically; the loop's ReadTrace uses it to tell an unchanged re-read
    // from a refetch after the file changed. Cheap: the bytes are already in memory.
    const contentHash = createHash('sha1').update(text).digest('hex');
    const lines = text.split('\n');
    // A file ending in '\n' yields a trailing '' element; don't count it as a real
    // line, or the continuation marker below claims "1 more line" pointing at nothing.
    const total =
      lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    // A path outside cwd relativizes to a long `../../..` chain, which a weak model then copies
    // into its next call; echo what it gave us instead. Common since spill locators live in tmp.
    const relToCwd = relative(ctx.cwd, full);
    const rel = relToCwd && !relToCwd.startsWith('..') ? relToCwd : path;

    // Reading past EOF returns an empty slice with a nonsensical range; say so plainly
    // instead, so a weak model gets a clear correction rather than a blank to retry against.
    if (offset > total) {
      return {
        summary: `Read ${rel}: offset ${offset} past end of file (${total} lines)`,
        payload: `(offset ${offset} is past the end of ${rel}, which has ${total} lines — re-read with a smaller offset)`,
        contentHash,
      };
    }

    const sliceEnd = Math.min(offset - 1 + limit, total);
    const slice = lines.slice(offset - 1, sliceEnd);
    const end = offset - 1 + slice.length;
    // Gutter uses `│` (not spaces) so the line-number field can't be mistaken
    // for the line's own leading indentation — everything after `│` is verbatim
    // file content. This keeps weaker models from mis-counting whitespace when
    // they copy text into an edit's old_string.
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5, ' ')}│${l}`).join('\n');
    // The summary's "of N" is evicted with the payload when this result ages out, so
    // the "more below" signal must live in the payload itself, at the point of recency,
    // and spell out the exact next call — weak models won't infer the offset arithmetic.
    const remaining = total - end;
    const more =
      remaining > 0
        ? `\n…(${remaining} more line${remaining === 1 ? '' : 's'} below — call read with offset=${end + 1} to continue)`
        : '';
    return {
      summary: `Read ${rel} lines ${offset}-${end} of ${total}`,
      payload: numbered + more,
      contentHash,
    };
  },
};
