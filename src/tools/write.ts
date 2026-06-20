import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import type { Tool } from '../types.js';
import { buildWriteDiff } from './_diff.js';
import { surfaceImportedDeps } from './_deps.js';

export const writeTool: Tool = {
  name: 'write',
  description:
    'Create a new file with the given content. Fails if the file already exists — use edit for modifications. Parent directories are created as needed.',
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

    const diffText = buildWriteDiff(content);

    if (ctx.requestApproval) {
      const ok = await ctx.requestApproval({
        tool: 'write',
        subject: rel,
        preview: diffText,
        startLine: 1,
      });
      if (!ok) return { summary: `Write declined by user for ${rel}` };
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const added = diffText.split('\n').filter(l => l.startsWith('+ ')).length;
    // Ground any dependency this new file imports: surface its real installed API so the
    // model corrects an assumed shape instead of building on a hallucinated one.
    const payload = await surfaceImportedDeps(ctx, content);
    return {
      summary: `Wrote ${rel} (+${added})`,
      diff: { text: diffText, path: rel, added, removed: 0, startLine: 1 },
      ...(payload ? { payload } : {}),
    };
  },
};
