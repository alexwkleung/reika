import { describe, expect, it } from 'vitest';
import { flagRepeatedCall, buildAgentLoopLedger } from './loop.js';

// Convenience: read calls keyed on path+offset.
const read = (
  seen: Map<string, number>,
  args: Record<string, unknown>,
  summary: string,
  payload: string | undefined = 'body',
) => flagRepeatedCall(seen, 'read', args, summary, payload);

describe('flagRepeatedCall', () => {
  it('leaves the first call untouched', () => {
    const seen = new Map<string, number>();
    expect(read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800')).toBe('body');
  });

  it('flags a window-varying re-read from the same offset (the real loop)', () => {
    const seen = new Map<string, number>();
    // All start at line 1 with different limits -> different summaries, same (path, offset).
    read(seen, { path: 'a.ts', limit: 100 }, 'Read a.ts lines 1-100 of 800');
    const second = read(seen, { path: 'a.ts', limit: 300 }, 'Read a.ts lines 1-300 of 800');
    const third = read(seen, { path: 'a.ts', limit: 80 }, 'Read a.ts lines 1-80 of 800');
    expect(second).toContain('2 times');
    expect(third).toContain('3 times');
    expect(second?.startsWith('body')).toBe(true);
  });

  it('names the exact range in the read nudge (concrete redirect, not generic)', () => {
    const seen = new Map<string, number>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    const second = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    // Points at the specific range via the summary, and keeps the escalating count.
    expect(second).toContain('Read a.ts lines 1-200 of 800');
    expect(second).toContain('2 times');
    expect(second).toContain('re-reading the same start line returns identical bytes');
    expect(second?.startsWith('body')).toBe(true);
  });

  it('does not flag genuine forward paging (different offsets)', () => {
    const seen = new Map<string, number>();
    const a = read(seen, { path: 'a.ts', offset: 1 }, 'Read a.ts lines 1-200 of 800', 'b1');
    const b = read(seen, { path: 'a.ts', offset: 200 }, 'Read a.ts lines 200-399 of 800', 'b2');
    const c = read(seen, { path: 'a.ts', offset: 400 }, 'Read a.ts lines 400-599 of 800', 'b3');
    expect(a).toBe('b1');
    expect(b).toBe('b2');
    expect(c).toBe('b3');
  });

  it('tracks bash repeats keyed on summary (incl. byte count)', () => {
    const seen = new Map<string, number>();
    const s = 'Ran: grep -n blendAlbums src/server/index.ts (140 bytes output)';
    flagRepeatedCall(seen, 'bash', { command: 'grep -n blendAlbums src/server/index.ts' }, s, 'o');
    const again = flagRepeatedCall(
      seen,
      'bash',
      { command: 'grep -n blendAlbums src/server/index.ts' },
      s,
      'o',
    );
    expect(again).toContain('2 times');
  });

  it('does not flag bash when output size differs (changed/flaky command)', () => {
    const seen = new Map<string, number>();
    flagRepeatedCall(
      seen,
      'bash',
      { command: 'npm test' },
      'Ran: npm test (1200 bytes output)',
      'o',
    );
    const again = flagRepeatedCall(
      seen,
      'bash',
      { command: 'npm test' },
      'Ran: npm test (1500 bytes output)',
      'o',
    );
    expect(again).toBe('o'); // different byte count -> different summary -> not a repeat
  });

  it('bash does NOT clear read-tracking (interspersed grep -n must not reset it)', () => {
    const seen = new Map<string, number>();
    read(seen, { path: 'a.ts', limit: 100 }, 'Read a.ts lines 1-100 of 800');
    flagRepeatedCall(
      seen,
      'bash',
      { command: 'grep -n x a.ts' },
      'Ran: grep -n x a.ts (10 bytes output)',
      'o',
    );
    const second = read(seen, { path: 'a.ts', limit: 300 }, 'Read a.ts lines 1-300 of 800');
    expect(second).toContain('2 times'); // read memory survived the bash call
  });

  it('edit/write resets memory so a later identical read is not flagged', () => {
    const seen = new Map<string, number>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    flagRepeatedCall(seen, 'edit', { path: 'a.ts' }, 'Edited a.ts', undefined);
    const after = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    expect(after).toBe('body');
  });

  it('passes untracked tools (fetch/search) through without flagging or clearing', () => {
    const seen = new Map<string, number>();
    read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    const fetched = flagRepeatedCall(seen, 'fetch_url', { url: 'x' }, 'Fetched x', 'page');
    expect(fetched).toBe('page');
    // read memory not cleared by the untracked tool:
    const second = read(seen, { path: 'a.ts' }, 'Read a.ts lines 1-200 of 800');
    expect(second).toContain('2 times');
  });

  it('escalates the grep count across identical-pattern repeats', () => {
    const seen = new Map<string, number>();
    const s = 'Found 0 matches for /discover/';
    flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '');
    flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '');
    expect(flagRepeatedCall(seen, 'grep', { pattern: 'discover' }, s, '')).toContain('3 times');
  });

  it('handles an undefined payload on a repeat without crashing', () => {
    const seen = new Map<string, number>();
    read(seen, { path: 'a.ts', offset: 999 }, 'Read a.ts: offset 999 past end of file', undefined);
    const out = read(
      seen,
      { path: 'a.ts', offset: 999 },
      'Read a.ts: offset 999 past end of file',
      undefined,
    );
    expect(out).toMatch(/2 times/);
  });
});

describe('buildAgentLoopLedger', () => {
  it('names the looping files and gives a stop-or-explain directive', () => {
    const ledger = buildAgentLoopLedger([
      { path: 'packages/ui/src/api/sse.ts', offset: 1, repeats: 3 },
      { path: 'packages/server/src/http/chat.ts', offset: 201, repeats: 3 },
    ]);
    // Names both files (the one past line 1 carries its offset), persists the "already read" fact,
    // and offers the non-edit escape so a cornered model isn't forced into a wrong change.
    expect(ledger).toContain('packages/ui/src/api/sse.ts');
    expect(ledger).toContain('packages/server/src/http/chat.ts:L201');
    expect(ledger).toContain('identical bytes');
    expect(ledger).toContain('state specifically what is still blocking you');
  });

  it('escalates to a hard pause directive once inspection tools are withdrawn', () => {
    const looping = [{ path: 'packages/server/src/http/chat.ts', offset: 151, repeats: 3 }];
    const soft = buildAgentLoopLedger(looping, false);
    const hard = buildAgentLoopLedger(looping, true);
    // Soft tier: still frames re-reading as unhelpful. Hard tier: states reading is paused.
    expect(soft).toContain('Re-reading them returns identical bytes');
    expect(soft).not.toContain('PAUSED');
    expect(hard).toContain('PAUSED');
    expect(hard).toContain('Make the edit');
    // Both name the looping file and keep the blocker escape.
    expect(hard).toContain('chat.ts:L151');
    expect(hard).toContain('what is still blocking you');
  });

  it('caps the listed files so a pathological turn cannot bloat the system prompt', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({
      path: `f${n}.ts`,
      offset: 1,
      repeats: 3,
    }));
    const ledger = buildAgentLoopLedger(many);
    expect(ledger).toContain('f0.ts');
    expect(ledger).toContain('f7.ts');
    expect(ledger).not.toContain('f8.ts'); // sliced at 8
  });
});
