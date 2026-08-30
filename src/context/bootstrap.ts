import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContextBundle } from '../types.js';
import { debugLog } from '../debug.js';
import { formatBundleSize } from './bundlesize.js';
import { buildRepoMap } from './repomap.js';
import { buildFileIndex } from './files.js';
import { loadGitignore } from './gitignore.js';
import { loadSkills } from '../skills.js';

export async function bootstrap(cwd: string, repoMapBudget?: number): Promise<ContextBundle> {
  const ig = await loadGitignore(cwd);
  const [projectSummary, instructions, repoMap, fileIndex, skills] = await Promise.all([
    summarizeProject(cwd),
    loadInstructions(cwd),
    buildRepoMap(cwd, ig, repoMapBudget),
    buildFileIndex(cwd, ig),
    loadSkills(cwd),
  ]);

  const hash = createHash('sha256')
    .update(`${projectSummary}\n${instructions}\n${repoMap}`)
    .digest('hex')
    .slice(0, 16);

  const bundle: ContextBundle = {
    projectSummary,
    repoMap,
    instructions,
    cwd,
    hash,
    fileIndex,
    ignore: ig,
    skills,
  };
  // Logged here rather than at the call site so a /cd re-index reports its new bundle too.
  debugLog(formatBundleSize(bundle));
  return bundle;
}

async function summarizeProject(cwd: string): Promise<string> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const visible = entries
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .slice(0, 40)
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  return `Top-level entries: ${visible.join(', ')}`;
}

// Above this size the instructions file stops being standing context and starts
// crowding out the conversation on small windows (12KB ≈ 3k tokens), so we fall
// back to an outline + read pointer instead of the full text.
const INSTRUCTIONS_BUDGET = 12 * 1024;

async function loadInstructions(cwd: string): Promise<string> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const content = await readFile(join(cwd, name), 'utf8');
      return content.length > INSTRUCTIONS_BUDGET ? outlineInstructions(content, name) : content;
    } catch {}
  }
  return '';
}

export function outlineInstructions(content: string, name: string): string {
  const headings: string[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,3} /.test(line)) headings.push(line);
  }
  const body = headings.length ? headings.join('\n') : content.slice(0, INSTRUCTIONS_BUDGET);
  return [
    `${name} is too large to include in full (${content.length} chars). ${headings.length ? 'Section outline:' : 'Beginning of file:'}`,
    body,
    `Read the relevant section of ${name} when its guidance matters for the task.`,
  ].join('\n');
}
