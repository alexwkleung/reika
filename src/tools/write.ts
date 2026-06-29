import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import type { Tool } from '../types.js';
import { buildWriteDiff } from './_diff.js';
import { surfaceImportedDeps } from './_deps.js';
import { groundUrls } from './_urls.js';

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
    // Ground what this new file introduces: surface the real installed API of any dependency it
    // imports, and fetch any URL it names — so the model corrects an assumed shape or a dead link
    // instead of building on a hallucinated one. Independent, so run concurrently.
    const [depPayload, urlPayload] = await Promise.all([
      surfaceImportedDeps(ctx, content),
      groundUrls(ctx, content),
    ]);
    const payload = [depPayload, urlPayload].filter(Boolean).join('\n\n') || undefined;
    return {
      summary: `Wrote ${rel} (+${added})`,
      diff: { text: diffText, path: rel, added, removed: 0, startLine: 1 },
      ...(payload ? { payload } : {}),
    };
  },
};
