import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SKILL_CONFIRM_APPLY, SKILL_CONFIRM_SEND, SkillConfirm } from './SkillConfirm.js';
import { matchSkill } from '../skillmatch.js';
import type { Skill } from '../skills.js';

const review: Skill = {
  name: 'review',
  description: 'read a GitHub pull request with gh, then review the diff',
  body: 'run `gh pr view`',
  source: 'project',
  path: '/repo/.reika/skills/review.md',
  triggers: ['review pr'],
};

const plain = (frame: string | undefined): string[] =>
  (frame ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map(l => l.trim());

function frame(selectedIndex: number): string[] {
  const match = matchSkill('review pr 420', [review])!;
  const { lastFrame } = render(<SkillConfirm match={match} selectedIndex={selectedIndex} />);
  return plain(lastFrame());
}

describe('SkillConfirm', () => {
  it('names the skill, the matched phrase, and numbers the rows with send-as-typed first', () => {
    const rows = frame(SKILL_CONFIRM_SEND);
    expect(rows.some(r => r.includes('⏺︎ Skill') && r.includes('/review — read a GitHub'))).toBe(
      true,
    );
    expect(rows.some(r => r.includes('matched: review pr'))).toBe(true);
    const send = rows.findIndex(r => r.includes('1. Send as typed'));
    const apply = rows.findIndex(r => r.includes('2. Apply /review'));
    expect(send).toBeGreaterThanOrEqual(0);
    expect(apply).toBe(send + 1);
    // The cursor sits on row 0 — the inverse of Approval, where the acting row is first.
    expect(rows[send]).toMatch(/^› 1\./);
    expect(rows[apply]).not.toContain('›');
  });

  it('moves the marker with the selection', () => {
    const rows = frame(SKILL_CONFIRM_APPLY);
    expect(rows.find(r => r.includes('2. Apply /review'))).toMatch(/› 2\./);
    expect(rows.find(r => r.includes('1. Send as typed'))).not.toContain('›');
  });

  it('says where y lands, since the row order inverts the approval dialog', () => {
    const rows = frame(SKILL_CONFIRM_SEND);
    expect(rows.some(r => r.includes('y = apply'))).toBe(true);
    // Merged with the input frame below: no bottom border of its own.
    expect(rows.some(r => r.startsWith('╰'))).toBe(false);
  });
});
