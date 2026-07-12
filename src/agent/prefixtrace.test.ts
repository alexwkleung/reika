import { describe, expect, it } from 'vitest';
import { PrefixTrace } from './prefixtrace.js';

const sys = (content: string) => ({ role: 'system', content });
const user = (content: string) => ({ role: 'user', content });
const tool = (content: string) => ({ role: 'tool', content });

describe('PrefixTrace', () => {
  it('classifies the first request', () => {
    const t = new PrefixTrace();
    const d = t.record([sys('S'), user('hi')]);
    expect(d.cause).toBe('first-request');
    expect(d.stableChars).toBe(0);
  });

  it('classifies a pure append as append-only with the full prior request stable', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('hi')]);
    const d = t.record([sys('S'), user('hi'), tool('result')]);
    expect(d.cause).toBe('append-only');
    expect(d.stableMessages).toBe(2);
    expect(d.stableChars).toBe(JSON.stringify(sys('S')).length + JSON.stringify(user('hi')).length);
  });

  it('classifies a system-prompt change as system-changed (nothing reusable)', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('hi')]);
    const d = t.record([sys('S + ledger'), user('hi')]);
    expect(d.cause).toBe('system-changed');
    expect(d.stableMessages).toBe(0);
  });

  it('classifies a rewritten earlier message as mid-history and names its role', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('hi'), tool('summary\n\nFULL PAYLOAD'), user('next')]);
    const d = t.record([sys('S'), user('hi'), tool('summary'), user('next'), tool('new')]);
    expect(d.cause).toBe('mid-history');
    expect(d.stableMessages).toBe(2);
    expect(d.changedRole).toBe('tool');
  });

  it('counts the intra-message common prefix toward stable chars', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), tool('summary\n\nPAYLOAD')]);
    const d = t.record([sys('S'), tool('summary')]);
    // The aged message still shares its "summary" prefix bytes with the live version.
    expect(d.stableChars).toBeGreaterThan(JSON.stringify(sys('S')).length);
  });

  it('classifies a shorter request (compaction) as shrunk', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('a'), user('b'), user('c')]);
    const d = t.record([sys('S'), user('a')]);
    expect(d.cause).toBe('shrunk');
    expect(d.changedRole).toBe('user');
  });
});
