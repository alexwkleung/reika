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
    const outside = escapesProject(ctx.cwd, full);
    // Two names for the same file, deliberately. `rel` stays project-relative because it is what
    // rides `diff.path`, and App.tsx feeds that straight to addFileToIndex -> ignore, which throws
    // a RangeError on an absolute path. `display` is the human- and model-facing string: an
    // out-of-project path renders through `relative` as a `../../../..` chain, which is noise in
    // the modal and in every summary, so those show the resolved path instead.
    const rel = relative(ctx.cwd, full) || path;
    const display = outside ? full : rel;

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

    const diffText = buildWriteDiff(content);

    // Outside the project, approval comes BEFORE the stat below. That call answers whether the file
    // exists ("already exists; use edit instead") — a fact about a path the user has not yet agreed
    // we may look at, and one the model can read back. The preview costs nothing here: it is the
    // model's own content, not the file's, so gating early loses no information. Inside the
    // project the order is unchanged.
    let approved = false;
    if (outside && ctx.requestApproval) {
      const ok = await ctx.requestApproval({
        tool: 'write',
        subject: display,
        preview: diffText,
        startLine: 1,
        warnings: [OUTSIDE_PROJECT_WARNING],
      });
      if (!ok) return { summary: `Write declined by user for ${display}` };
      approved = true;
    }

    const existing = await stat(full).catch(() => null);
    if (existing) {
      return { summary: `Write failed: ${display} already exists; use edit instead` };
    }

    if (ctx.requestApproval && !approved) {
      const ok = await ctx.requestApproval({
        tool: 'write',
        subject: display,
        preview: diffText,
        startLine: 1,
      });
      if (!ok) return { summary: `Write declined by user for ${display}` };
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const added = diffText.split('\n').filter(l => l.startsWith('+ ')).length;
    // Ground what this new file introduces: surface the real installed API of any dependency it
    // imports, and fetch any URL it names — so the model corrects an assumed shape or a dead link
    // instead of building on a hallucinated one. Independent, so run concurrently.
    const [depPayload, url] = await Promise.all([
      surfaceImportedDeps(ctx, content),
      groundUrls(ctx, content, rel),
    ]);
    const payload = [depPayload, url.note].filter(Boolean).join('\n\n') || undefined;
    return {
      summary: `Wrote ${display} (+${added})`,
      diff: { text: diffText, path: rel, added, removed: 0, startLine: 1 },
      ...(payload ? { payload } : {}),
      ...(url.notice ? { notice: url.notice } : {}),
    };
  },
};
