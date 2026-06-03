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
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const end = offset - 1 + slice.length;
    // Gutter uses `│` (not spaces) so the line-number field can't be mistaken
    // for the line's own leading indentation — everything after `│` is verbatim
    // file content. This keeps weaker models from mis-counting whitespace when
    // they copy text into an edit's old_string.
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5, ' ')}│${l}`).join('\n');
    const rel = relative(ctx.cwd, full) || path;
    return {
      summary: `Read ${rel} lines ${offset}-${end} of ${lines.length}`,
      payload: numbered,
    };
  },
};
