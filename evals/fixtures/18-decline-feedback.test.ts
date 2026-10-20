import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import { REASON, classifyDeclineReaction, feedbackFixture } from './18-decline-feedback.js';

const bash = (command: string): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: command, name: 'bash', args: { command } }],
});
const declinedResult = (command: string): Message => ({
  role: 'tool',
  callId: command,
  summary: `Bash declined by user: ${command}\nThe user said what to do instead: ${REASON}`,
});

describe('classifyDeclineReaction', () => {
  it('credits a later run of the named file, not the reason echoed in the summary', () => {
    expect(classifyDeclineReaction([bash('npm test'), declinedResult('npm test')])).toEqual({
      kind: 'stopped',
      declined: 'npm test',
    });
    expect(
      classifyDeclineReaction([
        bash('npm test'),
        declinedResult('npm test'),
        bash('node --test test/math.test.js'),
      ]),
    ).toMatchObject({ kind: 'followed', immediate: true });
  });

  it('marks a follow that came after another command as not immediate', () => {
    expect(
      classifyDeclineReaction([bash('npm test'), bash('ls test'), bash('node test/math.test.js')]),
    ).toMatchObject({ kind: 'followed', immediate: false });
  });

  it('reads a re-run of the declined command as a retry, whitespace aside', () => {
    expect(classifyDeclineReaction([bash('npm test'), bash('npm  test ')])).toEqual({
      kind: 'retried',
      declined: 'npm test',
    });
    expect(
      classifyDeclineReaction([bash('npm test'), bash('npm test'), bash('node test/math.test.js')]),
    ).toMatchObject({ kind: 'retried' });
  });

  it('ignores exploration before the first test run', () => {
    expect(
      classifyDeclineReaction([bash('cat package.json'), bash('pnpm test'), bash('pnpm run lint')]),
    ).toEqual({ kind: 'other', declined: 'pnpm test', next: 'pnpm run lint' });
    expect(classifyDeclineReaction([bash('ls')])).toEqual({ kind: 'never-ran' });
  });
});

describe('the approver', () => {
  it('declines the first test run only, with the reason, and approves everything else', () => {
    const approve = feedbackFixture.approver!();
    const req = (tool: string, preview: string) => ({ tool, subject: preview, preview });
    expect(approve(req('bash', 'ls'))).toBe(true);
    expect(approve(req('write', 'npm test'))).toBe(true);
    expect(approve(req('bash', 'npm test'))).toEqual({ feedback: REASON });
    expect(approve(req('bash', 'npm test'))).toBe(true);
    expect(feedbackFixture.approver!()(req('bash', 'npm test'))).toEqual({ feedback: REASON });
  });
});
