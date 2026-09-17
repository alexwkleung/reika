import { describe, expect, it } from 'vitest';
import { autoApproves } from './approval.js';
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
