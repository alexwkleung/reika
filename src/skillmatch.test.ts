import { describe, expect, it } from 'vitest';
import { matchSkill, shouldAutoInject } from './skillmatch.js';
import type { Skill } from './skills.js';

function skill(name: string, triggers: string[] = [], body = 'do the thing'): Skill {
  return {
    name,
    description: `the ${name} skill`,
    body,
    source: 'project',
    path: `/tmp/${name}.md`,
    triggers,
  };
}

describe('matchSkill', () => {
  it('matches on the skill name as an implicit trigger', () => {
    const m = matchSkill('verify my changes work', [skill('verify')]);
    expect(m?.skill.name).toBe('verify');
    expect(m?.matched).toEqual(['verify']);
  });

  it('matches a hyphenated skill name spoken with a space', () => {
    const m = matchSkill('please run a smoke test on this', [skill('smoke-test')]);
    expect(m?.skill.name).toBe('smoke-test');
  });

  it('scores multi-word triggers higher than single words', () => {
    const m = matchSkill('can you run the app for me', [skill('run', ['run the app'])]);
    // 'run' (1) + 'run the app' (3)
    expect(m?.score).toBe(4);
  });

  it('requires whole-word matches', () => {
    expect(matchSkill('what is the latest version', [skill('test')])).toBeNull();
    expect(matchSkill('reverify the output', [skill('verify')])).toBeNull();
  });

  it('matches across punctuation', () => {
    expect(matchSkill('verify, then commit', [skill('verify')])).not.toBeNull();
  });

  it('returns null when two skills tie', () => {
    const m = matchSkill('verify the build', [skill('verify'), skill('build')]);
    expect(m).toBeNull();
  });

  it('picks the higher-scoring skill when there is a clear winner', () => {
    const m = matchSkill('verify the build works', [
      skill('verify', ['verify the build']),
      skill('build'),
    ]);
    expect(m?.skill.name).toBe('verify');
  });

  it('ignores continuation prompts so a skill never fires on "yes"', () => {
    const skills = [skill('go', ['go'])];
    for (const p of ['yes', 'ok', 'go ahead', 'continue', 'do it']) {
      expect(matchSkill(p, skills)).toBeNull();
    }
  });

  it('drops sub-3-char triggers and names', () => {
    expect(matchSkill('go to the store', [skill('go')])).toBeNull();
  });

  it('returns null with no skills or no match', () => {
    expect(matchSkill('anything', [])).toBeNull();
    expect(matchSkill('write a haiku', [skill('deploy')])).toBeNull();
  });
});

describe('shouldAutoInject', () => {
  it('refuses a single-word match — a suggestion is the ceiling there', () => {
    const m = matchSkill('verify this', [skill('verify')])!;
    expect(m.score).toBe(1);
    expect(shouldAutoInject(m, 32_000)).toBe(false);
  });

  it('accepts a multi-word trigger on its own', () => {
    const m = matchSkill('run the app please', [skill('launch', ['run the app'])])!;
    expect(shouldAutoInject(m, 32_000)).toBe(true);
  });

  it('accepts two corroborating single-word triggers', () => {
    const m = matchSkill('verify the deploy', [skill('verify', ['deploy'])])!;
    expect(m.score).toBe(2);
    expect(shouldAutoInject(m, 32_000)).toBe(true);
  });

  it('refuses a body too large for the window', () => {
    const big = skill('launch', ['run the app'], 'x'.repeat(20_000));
    const m = matchSkill('run the app', [big])!;
    // 16k window * 2.5 chars/token * 0.15 = 6000 chars allowed
    expect(shouldAutoInject(m, 16_000)).toBe(false);
    expect(shouldAutoInject(m, 128_000)).toBe(true);
  });

  it('falls back to a fixed cap when the window is unknown', () => {
    const m = matchSkill('run the app', [skill('launch', ['run the app'], 'x'.repeat(7000))])!;
    expect(shouldAutoInject(m, undefined)).toBe(false);
  });
});
