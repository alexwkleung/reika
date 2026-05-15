import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Tool } from '../types.js';

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace one exact-match occurrence of old_string with new_string in a file. Fails if old_string is missing or appears more than once — add surrounding context to make it unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd.' },
      old_string: { type: 'string', description: 'Exact text to replace. Include enough context to be unique in the file.' },
      new_string: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const path = String(args.path);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const full = resolve(ctx.cwd, path);
    const rel = relative(ctx.cwd, full) || path;

    if (oldStr === '') {
      return { summary: `Edit failed: old_string is empty` };
    }
    if (oldStr === newStr) {
      return { summary: `Edit failed: old_string and new_string are identical` };
    }

    const text = await readFile(full, 'utf8');
    const first = text.indexOf(oldStr);
    if (first === -1) {
      return { summary: `Edit failed: old_string not found in ${rel}` };
    }
    const second = text.indexOf(oldStr, first + oldStr.length);
    if (second !== -1) {
      return {
        summary: `Edit failed: old_string appears multiple times in ${rel}; add surrounding context to make it unique`,
      };
    }

    const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
    await writeFile(full, next, 'utf8');
    const line = text.slice(0, first).split('\n').length;
    return { summary: `Edited ${rel} at line ${line}` };
  },
};
