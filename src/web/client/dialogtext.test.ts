import { describe, expect, it } from 'vitest';
import { approvalHeading, diffStat, savedAgo } from './dialogtext.js';

describe('approvalHeading', () => {
  it('says what each tool will do', () => {
    expect(approvalHeading('bash', '/repo')).toEqual({
      verb: 'Run a command',
      target: null,
      where: '/repo',
    });
    expect(approvalHeading('edit', 'src/app.ts')).toEqual({
      verb: 'Edit',
      target: 'src/app.ts',
      where: null,
    });
    expect(approvalHeading('write', 'notes.md').verb).toBe('Write');
    expect(approvalHeading('fetch_url', 'example.com')).toMatchObject({
      verb: 'Fetch from',
      target: 'example.com',
    });
    expect(approvalHeading('mcp__docs__find', 'docs:find')).toMatchObject({
      verb: 'Mcp docs:find',
      target: 'docs:find',
    });
  });
});

describe('diffStat', () => {
  it('counts added and removed lines, and is null for none', () => {
    expect(diffStat('  a\n- b\n+ c\n+ d')).toEqual({ added: 2, removed: 1 });
    expect(diffStat('  unchanged')).toBeNull();
  });
});

describe('savedAgo', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  it('reads recent saves relatively and older ones as a date', () => {
    expect(savedAgo('2026-11-15T11:59:40Z', now)).toBe('just now');
    expect(savedAgo('2026-11-15T11:55:00Z', now)).toBe('5 min ago');
    expect(savedAgo('2026-11-15T10:00:00Z', now)).toBe('2 h ago');
    expect(savedAgo('2026-11-12T12:00:00Z', now)).toBe('3 d ago');
    expect(savedAgo('2026-10-01T12:00:00Z', now)).toBe('2026-10-01');
    expect(savedAgo('not a date', now)).toBe('not a date');
  });
});
