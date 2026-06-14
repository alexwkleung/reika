import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Tool } from '../types.js';

// line-ranged by default
export const readTool: Tool = {
  name: 'read',
  description:
    'Read lines from a file. Returns up to 200 lines by default. Use offset+limit for paging.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to cwd.' },
      offset: { type: 'integer', description: 'Starting line, 1-indexed. Default 1.' },
      limit: { type: 'integer', description: 'Max lines to return. Default 200.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const path = String(args.path);
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? 200));
    const full = resolve(ctx.cwd, path);
    const text = await readFile(full, 'utf8');
    const lines = text.split('\n');
    // A file ending in '\n' yields a trailing '' element; don't count it as a real
    // line, or the continuation marker below claims "1 more line" pointing at nothing.
    const total =
      lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    const rel = relative(ctx.cwd, full) || path;

    // Reading past EOF returns an empty slice with a nonsensical range; say so plainly
    // instead, so a weak model gets a clear correction rather than a blank to retry against.
    if (offset > total) {
      return {
        summary: `Read ${rel}: offset ${offset} past end of file (${total} lines)`,
        payload: `(offset ${offset} is past the end of ${rel}, which has ${total} lines — re-read with a smaller offset)`,
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
    };
  },
};
