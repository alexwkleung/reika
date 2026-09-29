// Skill loading — markdown files in a directory become slash commands.
// Files may have YAML frontmatter for metadata; falls back to first line as description.
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Skill = {
  name: string;
  description: string;
  body: string;
  source: 'bundled' | 'global' | 'project';
  path: string;
  // Phrases that route a plain-English prompt to this skill (`triggers:` frontmatter).
  // Matching is deterministic and lives in skillmatch.ts — the model never picks a skill.
  triggers: string[];
  // What the skill needs to do anything (`requires:` frontmatter): `gh` on PATH, a `github` remote.
  // A skill whose requirement is missing is not loaded — see skillRequirementsMet.
  requires?: string[];
};

const GLOBAL_DEFAULT = join(homedir(), '.config', 'reika', 'skills');
const PROJECT_RELATIVE = '.reika/skills';
// The skills that ship in the package (`issue`, `review`), beside `dist/` — one level up from this
// module whether it runs as src/skills.ts or dist/skills.js.
export const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export async function loadSkills(cwd: string, bundledDir = BUNDLED_DIR): Promise<Skill[]> {
  const globalDir = process.env.REIKA_SKILLS_DIR
    ? expandHome(process.env.REIKA_SKILLS_DIR)
    : GLOBAL_DEFAULT;
  const projectDir = join(cwd, PROJECT_RELATIVE);

  const [bundledSkills, globalSkills, projectSkills] = await Promise.all([
    loadFromDir(bundledDir, 'bundled'),
    loadFromDir(globalDir, 'global'),
    loadFromDir(projectDir, 'project'),
  ]);

  // The user's own copy wins: project over global over bundled, on name collision.
  const byName = new Map<string, Skill>();
  for (const s of [...bundledSkills, ...globalSkills, ...projectSkills]) byName.set(s.name, s);
  const env = await skillEnvironment(cwd, [...byName.values()]);
  return Array.from(byName.values())
    .filter(s => skillRequirementsMet(s, env))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- requirements (`requires:` frontmatter) --------------------------------------------------
// A skill that cannot run is left out rather than listed: `/issue` in a repo with no GitHub remote,
// or on a machine with no `gh`, would spend a turn on a first call that fails, and its triggers
// would still ask the routing question on every matching prompt. Both checks read files only —
// nothing is executed at startup — and `/cd` re-runs them through bootstrap. A requirement this
// version does not know is treated as unmet, so a skill written for a newer reika stays hidden
// instead of running without what it asked for.
export type SkillEnvironment = { gh: boolean; github: boolean };

export function skillRequirementsMet(skill: Skill, env: SkillEnvironment): boolean {
  return (skill.requires ?? []).every(r =>
    r === 'gh' ? env.gh : r === 'github' ? env.github : false,
  );
}

async function skillEnvironment(cwd: string, skills: Skill[]): Promise<SkillEnvironment> {
  const needed = new Set(skills.flatMap(s => s.requires ?? []));
  const [gh, github] = await Promise.all([
    needed.has('gh') ? onPath('gh') : false,
    needed.has('github') ? hasGitHubRemote(cwd) : false,
  ]);
  return { gh, github };
}

// Looked up, never run: `gh auth status` would cost a process (and possibly a network call) at every
// startup, and a logged-out gh fails loudly on the skill's first call anyway.
export async function onPath(bin: string, path = process.env.PATH ?? ''): Promise<boolean> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

// Any remote on github.com, read from the repo's own config. Walks up from cwd (a monorepo
// package), and follows a `.git` file to the real git dir and its `commondir`, which is where a
// worktree's or submodule's config lives.
export async function hasGitHubRemote(cwd: string): Promise<boolean> {
  const gitDir = await findGitDir(resolve(cwd));
  if (!gitDir) return false;
  let configDir = gitDir;
  try {
    const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    if (common) configDir = isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // an ordinary repo has no commondir
  }
  try {
    const config = await readFile(join(configDir, 'config'), 'utf8');
    return /^\s*url\s*=\s*\S*github\.com[:/]/m.test(config);
  } catch {
    return false;
  }
}

async function findGitDir(start: string): Promise<string | null> {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    try {
      const info = await stat(dotGit);
      if (info.isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'));
      if (pointer) return resolve(dir, pointer[1].trim());
    } catch {
      // no .git here
    }
    if (dirname(dir) === dir) return null;
  }
}

async function loadFromDir(dir: string, source: Skill['source']): Promise<Skill[]> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    // Resolve symlinks — Dirent.isDirectory() reports the symlink type, not its
    // target, so symlinked skill dirs (common when users keep skills in a git
    // repo and symlink into ~/.config/reika/skills/) would otherwise be skipped.
    entries = await Promise.all(
      raw.map(async e => {
        if (e.isSymbolicLink()) {
          try {
            const target = await stat(join(dir, e.name));
            return { name: e.name, isDir: target.isDirectory() };
          } catch {
            return { name: e.name, isDir: false };
          }
        }
        return { name: e.name, isDir: e.isDirectory() };
      }),
    );
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
    return {
      name,
      description,
      body: body.trim(),
      source,
      path,
      triggers: parseTriggers(meta.triggers),
      requires: parseRequires(meta.requires),
    };
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
  // The block-list form (`key:` then `  - item` lines) is folded into the same comma-joined
  // string the inline form produces, so consumers stay on Record<string, string> and don't
  // care which YAML shape the author used. Still not worth a yaml dep — see AGENTS.md.
  let listKey: string | null = null;
  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (listKey && line.startsWith('- ')) {
      const item = line
        .slice(2)
        .trim()
        .replace(/^["'](.*)["']$/, '$1');
      if (item) meta[listKey] = meta[listKey] ? `${meta[listKey]}, ${item}` : item;
      continue;
    }
    listKey = null;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
    if (!key) continue;
    meta[key] = value;
    if (!value) listKey = key;
  }
  return { meta, body };
}

// `triggers: verify, smoke test` / `triggers: [verify, smoke test]` / a block list — all reach
// here as one comma-joined string. Sub-3-char phrases are dropped: they carry no routing signal
// and would fire on half the prompts in the language.
// Not parseTriggers: that one drops entries under three characters, and `gh` is two.
export function parseRequires(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[(.*)\]$/, '$1')
    .split(',')
    .map(r => r.trim().toLowerCase())
    .filter(Boolean);
}

export function parseTriggers(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .replace(/^\[(.*)\]$/, '$1')
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length >= 3),
    ),
  ];
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
