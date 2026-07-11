import { describe, expect, it } from 'vitest';
import { ReadFirstGate, buildReadFirstDirective } from './readfirst.js';

const CWD = '/repo';

describe('ReadFirstGate', () => {
  it('bounces the first edit to an unread path, exactly once', () => {
    const gate = new ReadFirstGate(CWD);
    expect(gate.shouldBounce('src/app.ts')).toBe(true);
    // Re-issued without a read: fail-open, the edit runs as-is.
    expect(gate.shouldBounce('src/app.ts')).toBe(false);
  });

  it('never bounces a path that was read first', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('src/app.ts');
    expect(gate.shouldBounce('src/app.ts')).toBe(false);
  });

  it('grounds via a successful edit/write, so follow-up edits pass', () => {
    const gate = new ReadFirstGate(CWD);
    expect(gate.shouldBounce('src/app.ts')).toBe(true);
    // The re-issued edit ran and succeeded; the result carried the post-edit bytes.
    gate.ground('src/app.ts');
    expect(gate.shouldBounce('src/app.ts')).toBe(false);
  });

  it('tracks paths independently', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('src/a.ts');
    expect(gate.shouldBounce('src/a.ts')).toBe(false);
    expect(gate.shouldBounce('src/b.ts')).toBe(true);
  });

  it('normalizes path spellings to the same file', () => {
    const gate = new ReadFirstGate(CWD);
    gate.ground('./src/app.ts');
    expect(gate.shouldBounce('src/app.ts')).toBe(false);
    expect(gate.shouldBounce('/repo/src/lib.ts')).toBe(true);
    // The bounce keyed the normalized form: the relative spelling is the same file.
    expect(gate.shouldBounce('src/lib.ts')).toBe(false);
  });
});

describe('buildReadFirstDirective', () => {
  it('states the withholding, the fix, and the fail-open escape', () => {
    const d = buildReadFirstDirective('src/app.ts');
    expect(d).toContain('NOT applied');
    expect(d).toContain('Read src/app.ts first');
    expect(d).toContain('applied as-is');
  });
});
