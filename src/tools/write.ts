import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import type { Tool } from '../types.js';

export const writeTool: Tool = {
  name: 'write',
  description: 'Create a new file with the given content. Fails if the file already exists — use edit for modifications. Parent directories are created as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const path = String(args.path);
    const content = String(args.content ?? '');
    const full = resolve(ctx.cwd, path);
    const rel = relative(ctx.cwd, full) || path;

    const existing = await stat(full).catch(() => null);
    if (existing) {
      return { summary: `Write failed: ${rel} already exists; use edit instead` };
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const lines = content.split('\n').length;
    return { summary: `Wrote ${rel} (${lines} lines)` };
  },
};
