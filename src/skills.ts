// Skill loading — markdown files in a directory become slash commands.
// Files may have YAML frontmatter for metadata; falls back to first line as description.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

export type Skill = {
  name: string;
  description: string;
  body: string;
  source: 'global' | 'project';
  path: string;
};

const GLOBAL_DEFAULT = join(homedir(), '.config', 'reika', 'skills');
const PROJECT_RELATIVE = '.reika/skills';

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const globalDir = process.env.REIKA_SKILLS_DIR
    ? expandHome(process.env.REIKA_SKILLS_DIR)
    : GLOBAL_DEFAULT;
  const projectDir = join(cwd, PROJECT_RELATIVE);

  const globalSkills = await loadFromDir(globalDir, 'global');
  const projectSkills = await loadFromDir(projectDir, 'project');

  // Project skills shadow global on name collision.
  const byName = new Map<string, Skill>();
  for (const s of globalSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFromDir(dir: string, source: Skill['source']): Promise<Skill[]> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    entries = raw.map(e => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  // Use a map so directory form wins over flat-file form on name collision within the same dir.
  const byName = new Map<string, Skill>();
  for (const entry of entries) {
    if (entry.isDir) {
      const name = entry.name.toLowerCase();
      if (!isValidName(name)) continue;
      const skillFile = await findCanonicalSkillFile(join(dir, entry.name));
      if (!skillFile) continue;
      const loaded = await readSkill(skillFile, name, source);
      if (loaded) byName.set(name, loaded);
    } else {
      if (extname(entry.name).toLowerCase() !== '.md') continue;
      const name = entry.name.slice(0, -3).toLowerCase();
      if (!isValidName(name)) continue;
      const loaded = await readSkill(join(dir, entry.name), name, source);
      if (loaded && !byName.has(name)) byName.set(name, loaded);
    }
  }
  return Array.from(byName.values());
}

async function findCanonicalSkillFile(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    // Case-insensitive match for SKILL.md (Claude Code convention).
    const match = entries.find(e => e.toLowerCase() === 'skill.md');
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

async function readSkill(
  path: string,
  name: string,
  source: Skill['source'],
): Promise<Skill | null> {
  try {
    const text = await readFile(path, 'utf8');
    const { meta, body } = parseFrontmatter(text);
    const description = meta.description?.trim() || firstNonEmptyLine(body) || '(no description)';
    return { name, description, body: body.trim(), source, path };
  } catch {
    return null;
  }
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { meta: {}, body: text };
  }
  const startLen = text.startsWith('---\r\n') ? 5 : 4;
  const end = text.indexOf('\n---\n', startLen);
  const endCrlf = text.indexOf('\n---\r\n', startLen);
  const endIdx = end !== -1 ? end : endCrlf;
  if (endIdx === -1) return { meta: {}, body: text };
  const closeLen = end !== -1 ? 5 : 6;
  const yamlBlock = text.slice(startLen, endIdx);
  const body = text.slice(endIdx + closeLen);
  const meta: Record<string, string> = {};
  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
    if (key) meta[key] = value;
  }
  return { meta, body };
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }
  return undefined;
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
