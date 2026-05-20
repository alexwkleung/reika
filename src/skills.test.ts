import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills, parseFrontmatter } from './skills.js';

describe('parseFrontmatter', () => {
  it('returns empty meta + full body when there is no frontmatter', () => {
    const { meta, body } = parseFrontmatter('just plain text\nhere');
    expect(meta).toEqual({});
    expect(body).toBe('just plain text\nhere');
  });

  it('parses simple key: value frontmatter', () => {
    const text = '---\ndescription: review the branch\n---\nbody text\nhere';
    const { meta, body } = parseFrontmatter(text);
    expect(meta).toEqual({ description: 'review the branch' });
    expect(body).toBe('body text\nhere');
  });

  it('strips surrounding quotes from values', () => {
    const text = '---\ndescription: "quoted value"\n---\nbody';
    const { meta } = parseFrontmatter(text);
    expect(meta.description).toBe('quoted value');
  });

  it('handles multiple keys', () => {
    const text = '---\ndescription: x\ntag: review\n---\nbody';
    const { meta } = parseFrontmatter(text);
    expect(meta).toEqual({ description: 'x', tag: 'review' });
  });

  it('skips comment lines starting with #', () => {
    const text = '---\n# a comment\ndescription: x\n---\nbody';
    const { meta } = parseFrontmatter(text);
    expect(meta).toEqual({ description: 'x' });
  });

  it('returns full body when frontmatter is unterminated', () => {
    const text = '---\ndescription: x\nbody never closes';
    const { meta, body } = parseFrontmatter(text);
    expect(meta).toEqual({});
    expect(body).toBe(text);
  });
});

describe('loadSkills', () => {
  let cwd: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-skills-'));
    originalEnv = process.env.REIKA_SKILLS_DIR;
    // Point global skills dir at a separate empty temp dir to isolate from user's actual config.
    process.env.REIKA_SKILLS_DIR = await mkdtemp(join(tmpdir(), 'reika-global-skills-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    const dir = process.env.REIKA_SKILLS_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.REIKA_SKILLS_DIR;
    else process.env.REIKA_SKILLS_DIR = originalEnv;
  });

  it('returns [] when no skills dirs exist', async () => {
    const skills = await loadSkills(cwd);
    expect(skills).toEqual([]);
  });

  it('loads project skills from .reika/skills/', async () => {
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/review.md'), 'Review the branch', 'utf8');
    const skills = await loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'review',
      body: 'Review the branch',
      source: 'project',
    });
    expect(skills[0].description).toBe('Review the branch');
  });

  it('uses frontmatter description when present', async () => {
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(
      join(cwd, '.reika/skills/review.md'),
      '---\ndescription: full branch review\n---\nbody here',
      'utf8',
    );
    const skills = await loadSkills(cwd);
    expect(skills[0].description).toBe('full branch review');
    expect(skills[0].body).toBe('body here');
  });

  it('falls back to first non-empty line as description without frontmatter', async () => {
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(
      join(cwd, '.reika/skills/r.md'),
      '\n\nReview thoroughly\nthen report\n',
      'utf8',
    );
    const skills = await loadSkills(cwd);
    expect(skills[0].description).toBe('Review thoroughly');
  });

  it('project skill shadows global skill with same name', async () => {
    const globalDir = process.env.REIKA_SKILLS_DIR as string;
    await writeFile(join(globalDir, 'review.md'), 'GLOBAL VERSION', 'utf8');
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/review.md'), 'PROJECT VERSION', 'utf8');
    const skills = await loadSkills(cwd);
    const review = skills.find(s => s.name === 'review');
    expect(review?.body).toBe('PROJECT VERSION');
    expect(review?.source).toBe('project');
  });

  it('skips non-.md files', async () => {
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/notes.txt'), 'ignored', 'utf8');
    await writeFile(join(cwd, '.reika/skills/ok.md'), 'kept', 'utf8');
    const skills = await loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('ok');
  });

  it('skips filenames with invalid characters', async () => {
    await mkdir(join(cwd, '.reika/skills'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/-bad.md'), 'leading dash', 'utf8');
    await writeFile(join(cwd, '.reika/skills/spaces are weird.md'), 'spaces', 'utf8');
    await writeFile(join(cwd, '.reika/skills/good_name-1.md'), 'ok', 'utf8');
    const skills = await loadSkills(cwd);
    expect(skills.map(s => s.name)).toEqual(['good_name-1']);
  });

  it('loads directory-form skills with SKILL.md inside', async () => {
    await mkdir(join(cwd, '.reika/skills/review'), { recursive: true });
    await writeFile(
      join(cwd, '.reika/skills/review/SKILL.md'),
      '---\ndescription: branch review\n---\nReview the branch end-to-end.',
      'utf8',
    );
    const skills = await loadSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'review',
      description: 'branch review',
      body: 'Review the branch end-to-end.',
    });
  });

  it('accepts lowercase skill.md inside a directory too', async () => {
    await mkdir(join(cwd, '.reika/skills/refactor'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/refactor/skill.md'), 'Refactor body', 'utf8');
    const skills = await loadSkills(cwd);
    expect(skills.map(s => s.name)).toContain('refactor');
  });

  it('ignores supporting files alongside SKILL.md', async () => {
    await mkdir(join(cwd, '.reika/skills/deploy'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/deploy/SKILL.md'), 'Deploy body', 'utf8');
    await writeFile(join(cwd, '.reika/skills/deploy/helper.sh'), '#!/bin/sh', 'utf8');
    await writeFile(join(cwd, '.reika/skills/deploy/notes.md'), 'random doc', 'utf8');
    const skills = await loadSkills(cwd);
    const deploy = skills.find(s => s.name === 'deploy');
    expect(deploy?.body).toBe('Deploy body');
    // Supporting files don't create separate skills
    expect(skills.filter(s => s.name.includes('deploy'))).toHaveLength(1);
  });

  it('skips directories without a SKILL.md inside', async () => {
    await mkdir(join(cwd, '.reika/skills/empty-dir'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/empty-dir/notes.md'), 'no canonical', 'utf8');
    const skills = await loadSkills(cwd);
    expect(skills.map(s => s.name)).not.toContain('empty-dir');
  });

  it('directory form wins over flat-file form on collision', async () => {
    await mkdir(join(cwd, '.reika/skills/review'), { recursive: true });
    await writeFile(join(cwd, '.reika/skills/review.md'), 'FLAT VERSION', 'utf8');
    await writeFile(join(cwd, '.reika/skills/review/SKILL.md'), 'DIR VERSION', 'utf8');
    const skills = await loadSkills(cwd);
    const review = skills.find(s => s.name === 'review');
    expect(review?.body).toBe('DIR VERSION');
  });
});
