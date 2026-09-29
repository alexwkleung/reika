import { describe, expect, it } from 'vitest';
import {
  autoApproveForced,
  autoApproves,
  declineSummary,
  formatUnattendedDeclines,
  effectiveAutoApprove,
} from './approval.js';
import type { ApprovalRequest } from './types.js';

const plain: ApprovalRequest = { tool: 'bash', subject: '/repo', preview: 'ls' };
const flagged: ApprovalRequest = { ...plain, preview: 'rm -rf x', warnings: ['rm -rf'] };

describe('autoApproves', () => {
  it('safe approves an unflagged request', () => {
    expect(autoApproves('safe', plain)).toBe(true);
  });

  it('safe still falls through on a flagged command', () => {
    expect(autoApproves('safe', flagged)).toBe(false);
  });

  it('an empty warnings list counts as unflagged', () => {
    expect(autoApproves('safe', { ...plain, warnings: [] })).toBe(true);
  });

  it('off approves nothing', () => {
    expect(autoApproves('off', plain)).toBe(false);
  });

  it('bypass is not a policy here — callers drop the gate instead', () => {
    expect(autoApproves('bypass', plain)).toBe(false);
  });
});

describe('effectiveAutoApprove', () => {
  const unset = { autoApprove: 'safe' as const, autoApproveExplicit: false };
  const envSafe = { autoApprove: 'safe' as const, autoApproveExplicit: true };
  const envOff = { autoApprove: 'off' as const, autoApproveExplicit: true };
  const envBypass = { autoApprove: 'bypass' as const, autoApproveExplicit: true };

  it('no config yet means nothing auto-runs', () => {
    expect(effectiveAutoApprove(null, null)).toBe('off');
    expect(effectiveAutoApprove(null, true)).toBe('off');
  });

  it('the unset default is safe until the session toggles it off', () => {
    expect(effectiveAutoApprove(unset, null)).toBe('safe');
    expect(effectiveAutoApprove(unset, false)).toBe('off');
    expect(effectiveAutoApprove(unset, true)).toBe('safe');
  });

  it('an explicit off is off until the session toggles it on', () => {
    expect(effectiveAutoApprove(envOff, null)).toBe('off');
    expect(effectiveAutoApprove(envOff, true)).toBe('safe');
  });

  it('an explicit safe or bypass shadows the session toggle', () => {
    expect(effectiveAutoApprove(envSafe, false)).toBe('safe');
    expect(effectiveAutoApprove(envBypass, false)).toBe('bypass');
  });

  it('autoApproveForced is true only for an explicit non-off mode', () => {
    expect(autoApproveForced(unset)).toBe(false);
    expect(autoApproveForced(envOff)).toBe(false);
    expect(autoApproveForced(envSafe)).toBe(true);
    expect(autoApproveForced(envBypass)).toBe(true);
    expect(autoApproveForced({ autoApprove: 'off' })).toBe(false);
  });
});

describe('declineSummary (#526)', () => {
  it('keeps the attended wording byte-identical', () => {
    expect(declineSummary('Bash', ': npm install', {})).toBe('Bash declined by user: npm install');
    expect(declineSummary('Edit', ' for src/a.ts', { unattended: false })).toBe(
      'Edit declined by user for src/a.ts',
    );
  });

  // "declined by user" reads to a model as a refusal to respect, and it stops or asks again.
  it('says nobody was there to approve when unattended, and steers the model on', () => {
    const s = declineSummary('Bash', ': npm install', { unattended: true });
    expect(s).not.toContain('by user');
    expect(s).toContain('npm install');
    expect(s).toContain('unattended');
    expect(s).toContain('Carry on without it');
  });
});

describe('formatUnattendedDeclines (#526)', () => {
  it('names a declined fetch by its URL, not its host (#548)', () => {
    const out = formatUnattendedDeclines([
      { tool: 'fetch_url', subject: 'evil.example', preview: 'https://evil.example/?d=x' },
    ]);
    expect(out).toContain('https://evil.example/?d=x');
  });

  it('is null when nothing was declined', () => {
    expect(formatUnattendedDeclines([])).toBeNull();
  });

  it('lists each decline: the command for bash, the path for edit and write', () => {
    const out = formatUnattendedDeclines([
      { tool: 'bash', subject: '/repo', preview: 'npm install left-pad\nsecond line' },
      { tool: 'write', subject: '~/.zshrc', preview: '+ export X=1' },
    ]);
    expect(out).toBe(
      [
        'Declined while unattended — 2 actions left for you:',
        // `toolLabel`, so a name the user reads is the one the dialog and the chip print.
        '  Bash: npm install left-pad',
        '  Write: ~/.zshrc',
      ].join('\n'),
    );
  });

  // #265: the tool name here is the model-facing wire name, and this list is for the user.
  it('spells an MCP decline as its command, not its wire name', () => {
    const out = formatUnattendedDeclines([
      { tool: 'mcp__filesystem__read_file', subject: 'filesystem:read_file', preview: '{"p":"a"}' },
    ]);
    expect(out).toContain('  Mcp filesystem:read_file: filesystem:read_file');
    expect(out).not.toContain('mcp__filesystem__read_file');
  });
});
