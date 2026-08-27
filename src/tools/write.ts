import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { escapesProject, OUTSIDE_PROJECT_WARNING, resolveUserPath } from './_paths.js';
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
    const full = resolveUserPath(ctx.cwd, path);
    // An out-of-project path renders through `relative` as a `../../../..` chain, which is noise to
    // the user in the modal and to the model in every summary. Show the resolved path instead.
    const outside = escapesProject(ctx.cwd, full);
    const rel = outside ? full : relative(ctx.cwd, full) || path;

    // A write outside the project is the one shape the approval gate never surfaced: neither tool
    // passed `warnings`, so under `safe` every write auto-approved to any path `resolveUserPath`
    // would produce — `~/.zshrc` included. Under `bypass` there is no modal to fall through to, so
    // the only honest answer is no; the model is told why, and that the project is where to write.
    if (outside && !ctx.requestApproval) {
      return {
        summary:
          `Write refused: ${full} is outside the project directory (${ctx.cwd}), and approvals ` +
          'are bypassed so it cannot be confirmed with the user. Write inside the project instead.',
      };
    }

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
        warnings: outside ? [OUTSIDE_PROJECT_WARNING] : undefined,
      });
      if (!ok) return { summary: `Write declined by user for ${rel}` };
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const added = diffText.split('\n').filter(l => l.startsWith('+ ')).length;
    // Ground what this new file introduces: surface the real installed API of any dependency it
    // imports, and fetch any URL it names — so the model corrects an assumed shape or a dead link
    // instead of building on a hallucinated one. Independent, so run concurrently.
    const [depPayload, url] = await Promise.all([
      surfaceImportedDeps(ctx, content),
      groundUrls(ctx, content),
    ]);
    const payload = [depPayload, url.note].filter(Boolean).join('\n\n') || undefined;
    return {
      summary: `Wrote ${rel} (+${added})`,
      diff: { text: diffText, path: rel, added, removed: 0, startLine: 1 },
      ...(payload ? { payload } : {}),
      ...(url.notice ? { notice: url.notice } : {}),
    };
  },
};
