import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContextBundle } from '../types.js';
import { debugLog, formatExperimentFlags } from '../debug.js';
import { formatBundleSize } from './bundlesize.js';
import { DEFAULT_BUDGET, packRepoMap, rankRepoMap } from './repomap.js';
import { buildFileIndex } from './files.js';
import { loadGitignore } from './gitignore.js';
import { loadSkills } from '../skills.js';

export async function bootstrap(
  cwd: string,
  repoMapBudget: number = DEFAULT_BUDGET,
): Promise<ContextBundle> {
  const ig = await loadGitignore(cwd);
  const [projectSummary, instructions, repoMapRanked, fileIndex, skills] = await Promise.all([
    summarizeProject(cwd),
    loadInstructions(cwd),
    rankRepoMap(cwd, ig),
    buildFileIndex(cwd, ig),
    loadSkills(cwd),
  ]);
  const repoMap = packRepoMap(repoMapRanked, repoMapBudget);

  const bundle: ContextBundle = {
    projectSummary,
    repoMap,
    repoMapRanked,
    repoMapBudget,
    instructions,
    cwd,
    hash: bundleHash(projectSummary, instructions, repoMap),
    fileIndex,
    ignore: ig,
    skills,
  };
  // Logged here rather than at the call site so a /cd re-index reports its new bundle too.
  debugLog(formatExperimentFlags());
  debugLog(formatBundleSize(bundle));
  return bundle;
}

// Same bundle, map packed to a new budget. Returns the bundle itself when nothing would change, so
// a caller comparing identity rewrites the system prompt (and loses the prefix cache) only on a
// real move. A hand-built bundle with no ranked lines has nothing to repack.
export function refitRepoMap(bundle: ContextBundle, budget: number): ContextBundle {
  if (!bundle.repoMapRanked || bundle.repoMapBudget === budget) return bundle;
  const repoMap = packRepoMap(bundle.repoMapRanked, budget);
  const next = { ...bundle, repoMapBudget: budget };
  if (repoMap === bundle.repoMap) return next;
  next.repoMap = repoMap;
  next.hash = bundleHash(bundle.projectSummary, bundle.instructions, repoMap);
  debugLog(formatBundleSize(next));
  return next;
}

function bundleHash(projectSummary: string, instructions: string, repoMap: string): string {
  return createHash('sha256')
    .update(`${projectSummary}\n${instructions}\n${repoMap}`)
    .digest('hex')
    .slice(0, 16);
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

const INSTRUCTIONS_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const GLOBAL_INSTRUCTIONS_DIR = join(homedir(), '.config', 'reika');

// Global (~/.config/reika/AGENTS.md) carries the user's personal preferences; the project
// file carries the repo's. Both go in when both exist, global first so the project's more
// specific guidance sits closer to the conversation and wins where they disagree. A lone
// project file is passed through byte-for-byte, as before.
export async function loadInstructions(
  cwd: string,
  globalDir: string = GLOBAL_INSTRUCTIONS_DIR,
): Promise<string> {
  const [global, project] = await Promise.all([
    readInstructionsFile(globalDir, '~/.config/reika'),
    readInstructionsFile(cwd, ''),
  ]);
  if (!global) return project;
  if (!project) return global;
  return [
    'Two instructions files apply. Where they disagree, the project file wins.',
    `--- Global (personal) instructions ---\n${global}`,
    `--- Project instructions ---\n${project}`,
  ].join('\n\n');
}

// `label` is how the file is named to the model — a `~` path for the global file so the
// outline's read pointer resolves to the right AGENTS.md rather than the project's.
async function readInstructionsFile(dir: string, label: string): Promise<string> {
  for (const name of INSTRUCTIONS_NAMES) {
    try {
      const content = await readFile(join(dir, name), 'utf8');
      const shown = label ? `${label}/${name}` : name;
      return content.length > INSTRUCTIONS_BUDGET ? outlineInstructions(content, shown) : content;
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
