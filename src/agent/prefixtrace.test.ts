import { describe, expect, it } from 'vitest';
import { PrefixTrace } from './prefixtrace.js';

const sys = (content: string) => ({ role: 'system', content });
const user = (content: string) => ({ role: 'user', content });
const tool = (content: string) => ({ role: 'tool', content });
const assistant = (content: string) => ({ role: 'assistant', content });

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

  // #253: prefix-stable rides a transient harness note (loop ledger / nudge) at the very end of the
  // prompt. It never enters history, so the next round's append lands on its slot and the byte
  // comparison sees a divergence there — real, but a fixed-size tail, not history churn. Reported as
  // `mid-history firstChanged=assistant` it read as payload aging invalidating the cache EVERY
  // round, which is the opposite of what the mode was doing.
  it('names the displaced trailing note instead of blaming the message that displaced it', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('hi'), user('(ledger)')], { trailingNote: true });
    const d = t.record([sys('S'), user('hi'), assistant('ok'), tool('r'), user('(ledger v2)')], {
      trailingNote: true,
    });
    expect(d.cause).toBe('trailing-note');
    expect(d.stableMessages).toBe(2);
    // The cause names what moved; a role here is the misreading the case exists to prevent.
    expect(d.changedRole).toBeUndefined();
  });

  it('still charges the note slot as diverged — the engine really does re-process it', () => {
    const t = new PrefixTrace();
    const before = [sys('S'), user('hi'), user('(ledger)')];
    t.record(before, { trailingNote: true });
    const d = t.record([sys('S'), user('hi'), assistant('ok'), user('(ledger)')], {
      trailingNote: true,
    });
    expect(d.stableChars).toBeLessThan(d.totalChars);
    // Only the shared `{"role":"` opening of the two differing messages is reusable.
    expect(d.stableChars).toBeLessThan(
      JSON.stringify(sys('S')).length + JSON.stringify(user('hi')).length + 20,
    );
  });

  it('reports a real history rewrite as mid-history even when a note also moved', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), tool('summary\n\nFULL PAYLOAD'), user('(ledger)')], {
      trailingNote: true,
    });
    const d = t.record([sys('S'), tool('summary'), assistant('ok'), user('(ledger)')], {
      trailingNote: true,
    });
    expect(d.cause).toBe('mid-history');
    expect(d.changedRole).toBe('tool');
  });

  it('falls back to mid-history when the caller does not flag a note', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('hi'), user('(ledger)')]);
    const d = t.record([sys('S'), user('hi'), assistant('ok'), user('(ledger v2)')]);
    expect(d.cause).toBe('mid-history');
  });

  it('classifies a shorter request (compaction) as shrunk', () => {
    const t = new PrefixTrace();
    t.record([sys('S'), user('a'), user('b'), user('c')]);
    const d = t.record([sys('S'), user('a')]);
    expect(d.cause).toBe('shrunk');
    expect(d.changedRole).toBe('user');
  });
});
