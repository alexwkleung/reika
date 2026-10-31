import { describe, expect, it } from 'vitest';
import { matchSkill, shouldAutoInject, shouldConfirmInject } from './skillmatch.js';
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
    expect(m?.score).toBe(3);
  });

  it('does not count a phrase twice through a longer phrase that contains it', () => {
    // The implicit name `issue` rides inside "issue number"; counted separately, every two-word
    // trigger containing the name cleared the auto bar on its own.
    const m = matchSkill('the issue number is shown twice', [skill('issue', ['issue number'])]);
    expect(m?.matched).toEqual(['issue number']);
    expect(m?.score).toBe(2);
    const two = matchSkill('review pr 420', [skill('review', ['review pr', 'pr review'])]);
    expect(two?.matched).toEqual(['review pr']);
  });

  it('records whether a matched phrase opens the prompt, past a courtesy lead', () => {
    const skills = [skill('review', ['review pr'])];
    expect(matchSkill('review pr 420', skills)?.leading).toBe(true);
    expect(matchSkill('ok please review pr 420', skills)?.leading).toBe(true);
    expect(matchSkill("let's review pr 420", skills)?.leading).toBe(true);
    expect(matchSkill('there is a bug in the review pr path', skills)?.leading).toBe(false);
    expect(matchSkill('the review pr path', skills)?.leading).toBe(false);
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

  // The shipped skills against prompts that merely mention their nouns: each one cleared the
  // score bar before the shape gate, prepending a body that opens with "run `gh pr view`".
  const shipped = [
    skill('issue', ['work on issue', 'gh issue', 'fix issue', 'look at issue', 'issue number']),
    skill('review', [
      'review pr',
      'pr review',
      'review the pull request',
      'pull request',
      'code review',
    ]),
  ];

  it('refuses a match that is not in the command position', () => {
    const descriptions = [
      'the code review comments say we should rename this',
      'add a pull request template to the repo',
      'there is an issue with the pr review flow in App.tsx',
      'why does gh issue list hang in bash mode',
      'the issue number is shown twice in the header',
    ];
    for (const p of descriptions) {
      const m = matchSkill(p, shipped);
      expect(m, p).not.toBeNull();
      expect(shouldAutoInject(m!, 24_000), p).toBe(false);
    }
  });

  it('accepts a command with its arguments', () => {
    for (const p of [
      'work on issue 412',
      'review pr 420',
      'please review the pull request',
      'gh issue 12, focus on the tests',
    ]) {
      expect(shouldAutoInject(matchSkill(p, shipped)!, 24_000), p).toBe(true);
    }
  });

  it('refuses a leading phrase buried in a long prompt', () => {
    const p =
      'review pr 420 but first explain how the compaction note is fitted into the recap and why';
    expect(shouldAutoInject(matchSkill(p, shipped)!, 24_000)).toBe(false);
  });

  // The confirm dialog (#425) is the auto gate minus the word cap: with a human answering, the
  // long-tail command can be asked about instead of only suggested — but a description that
  // merely mentions the nouns must still not prompt, or the dialog becomes the nag.
  describe('shouldConfirmInject', () => {
    it('asks about a leading phrase in a long prompt the silent gate refuses', () => {
      const p =
        'review pr 420 but first explain how the compaction note is fitted into the recap and why';
      const m = matchSkill(p, shipped)!;
      expect(shouldAutoInject(m, 24_000)).toBe(false);
      expect(shouldConfirmInject(m, 24_000)).toBe(true);
    });

    it('still refuses a match outside the command position', () => {
      for (const p of [
        'add a pull request template to the repo',
        'the issue number is shown twice in the header',
      ]) {
        expect(shouldConfirmInject(matchSkill(p, shipped)!, 24_000), p).toBe(false);
      }
    });

    it('still refuses a single-word match and an oversized body', () => {
      expect(shouldConfirmInject(matchSkill('verify this', [skill('verify')])!, 24_000)).toBe(
        false,
      );
      const big = skill('launch', ['run the app'], 'x'.repeat(20_000));
      expect(shouldConfirmInject(matchSkill('run the app', [big])!, 16_000)).toBe(false);
    });
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
