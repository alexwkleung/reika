import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContextBundle } from '../types.js';
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

  return { projectSummary, repoMap, instructions, cwd, hash, fileIndex, ignore: ig, skills };
}

async function summarizeProject(cwd: string): Promise<string> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const visible = entries
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .slice(0, 40)
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  return `Top-level entries: ${visible.join(', ')}`;
}

async function loadInstructions(cwd: string): Promise<string> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      return await readFile(join(cwd, name), 'utf8');
    } catch {}
  }
  return '';
}
