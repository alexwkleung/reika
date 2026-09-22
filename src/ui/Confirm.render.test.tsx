import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  CONFIRM_ACCEPT,
  CONFIRM_DECLINE,
  Confirm,
  type ConfirmSpec,
  pastedUrlConfirmSpec,
  skillConfirmSpec,
} from './Confirm.js';
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
    // The frame's right border rides every row (the left one sits outside the test viewport).
    .map(l => l.replace(/│/g, '').trim());

function frame(spec: ConfirmSpec, selectedIndex: number): string[] {
  const { lastFrame } = render(<Confirm spec={spec} selectedIndex={selectedIndex} />);
  return plain(lastFrame());
}

const skillSpec = () => skillConfirmSpec(matchSkill('review pr 420', [review])!);

describe('Confirm — skill', () => {
  it('names the skill, the matched phrase, and numbers the rows with send-as-typed first', () => {
    const rows = frame(skillSpec(), CONFIRM_DECLINE);
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
    const rows = frame(skillSpec(), CONFIRM_ACCEPT);
    expect(rows.find(r => r.includes('2. Apply /review'))).toMatch(/› 2\./);
    expect(rows.find(r => r.includes('1. Send as typed'))).not.toContain('›');
  });

  it('says where y lands, since the row order inverts the approval dialog', () => {
    const rows = frame(skillSpec(), CONFIRM_DECLINE);
    expect(rows.some(r => r.includes('y = apply'))).toBe(true);
    // Merged with the input frame below: no bottom border of its own.
    expect(rows.some(r => r.startsWith('╰'))).toBe(false);
  });
});

describe('Confirm — pasted link (#448)', () => {
  it('lists the link and offers the fetch on row 2, send-as-typed first', () => {
    const rows = frame(pastedUrlConfirmSpec(['https://example.com/unsubscribe?t=1']), 0);
    expect(rows.some(r => r.includes('⏺︎ Pasted link') && r.includes('fetch before the turn'))).toBe(
      true,
    );
    expect(rows.some(r => r === 'https://example.com/unsubscribe?t=1')).toBe(true);
    expect(rows.find(r => r.includes('1. Send as typed'))).toMatch(/^› 1\./);
    expect(rows.some(r => r.includes('2. Fetch the link'))).toBe(true);
    expect(rows.some(r => r.includes('y = fetch'))).toBe(true);
  });

  it('pluralizes for two links and shortens a long one', () => {
    const long = `https://example.com/${'a'.repeat(200)}`;
    const rows = frame(pastedUrlConfirmSpec(['https://example.com/x', long]), 1);
    expect(rows.some(r => r.includes('⏺︎ Pasted links'))).toBe(true);
    expect(rows.find(r => r.includes('2. Fetch 2 links'))).toMatch(/› 2\./);
    const shown = rows.find(r => r.startsWith('https://example.com/aaa'));
    expect(shown).toBeDefined();
    expect(shown!.length).toBeLessThan(long.length);
    expect(shown!.endsWith('…')).toBe(true);
  });
});
