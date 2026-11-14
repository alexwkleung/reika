import { describe, expect, it } from 'vitest';
import { resolveToggleCommand, toggleReceipt, type ToggleContext } from './togglecommands.js';

const ctx = (over: Partial<ToggleContext> = {}): ToggleContext => ({
  autoApprove: 'off',
  autoApproveForced: false,
  configAutoApprove: 'off',
  unattended: false,
  anon: false,
  ...over,
});

describe('resolveToggleCommand', () => {
  it('is null for a command that is not a toggle', () => {
    expect(resolveToggleCommand('model', 'on', ctx())).toBeNull();
  });

  it('sets each toggle from an explicit on or off, whatever the case', () => {
    for (const toggle of ['approvals', 'unattended', 'anon'] as const) {
      expect(resolveToggleCommand(toggle, ' ON ', ctx())).toEqual({
        kind: 'set',
        toggle,
        on: true,
      });
      expect(resolveToggleCommand(toggle, 'off', ctx())).toEqual({
        kind: 'set',
        toggle,
        on: false,
      });
    }
  });

  it('names the two forms for any other argument', () => {
    expect(resolveToggleCommand('anon', 'maybe', ctx())).toEqual({
      kind: 'reply',
      content: 'Unknown argument: maybe. Use /anon on or /anon off.',
    });
  });

  it('asks for the bare command, starting on the row that changes nothing', () => {
    expect(resolveToggleCommand('approvals', '', ctx({ autoApprove: 'safe' }))).toEqual({
      kind: 'ask',
      toggle: 'approvals',
      title: 'Approvals',
      subtitle: 'session auto-approve: safe — toggle on or off?',
      currentlyOn: true,
    });
    expect(resolveToggleCommand('unattended', '', ctx({ unattended: true }))).toMatchObject({
      kind: 'ask',
      title: 'Unattended',
      subtitle: 'currently on — toggle on or off?',
      currentlyOn: true,
    });
    expect(resolveToggleCommand('anon', '', ctx())).toMatchObject({
      kind: 'ask',
      title: 'Anonymize',
      subtitle: 'currently off — toggle on or off?',
      currentlyOn: false,
    });
  });

  it('refuses to set approvals when the env forces a mode, and says which', () => {
    const forced = ctx({ autoApproveForced: true, configAutoApprove: 'bypass' });
    expect(resolveToggleCommand('approvals', 'off', forced)).toEqual({
      kind: 'reply',
      content:
        "auto-approve is forced to 'bypass' by REIKA_AUTO_APPROVE; session toggle has no effect.",
    });
  });

  it('prints a status page for bare /approvals under a forced mode', () => {
    const forced = ctx({ autoApproveForced: true, configAutoApprove: 'safe', unattended: true });
    const page = resolveToggleCommand('approvals', '', forced);
    expect(page?.kind === 'reply' && page.content.split('\n')).toEqual([
      'auto-approve: safe',
      '  safe — ordinary actions auto-run; dangerous commands still prompt',
      '  source: REIKA_AUTO_APPROVE=safe (env)',
      '  unattended: on — anything that would prompt is declined instead (/unattended off)',
      '',
      'env REIKA_AUTO_APPROVE forces this; session toggle is shadowed',
    ]);
  });
});

describe('toggleReceipt', () => {
  it('says which way each switch went', () => {
    expect(toggleReceipt('approvals', true)).toBe('Session auto-approve: on');
    expect(toggleReceipt('unattended', false)).toBe(
      'unattended: off — approvals and questions prompt again.',
    );
    expect(toggleReceipt('anon', false)).toMatch(/^anonymize: off/);
  });

  it('reports what turning anonymize on found, or that it found nothing', () => {
    expect(toggleReceipt('anon', true, { names: 2, emails: 1 })).toContain(
      'substituting 2 name(s) → <user>, 1 email(s) → <email>',
    );
    expect(toggleReceipt('anon', true)).toContain('no identity found');
  });
});
