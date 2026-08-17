import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '../src/types.js';
import {
  callsAfterSpill,
  calledTool,
  lastAssistantContent,
  readsSpill,
  spilledPath,
} from './util.js';

// These helpers decide whether a spill eval passes, so a wrong answer here is indistinguishable
// from a model behaving differently — the failure mode that actually bit: a debug log was misread
// as "no read was dispatched" and a sound PASS was chased as a false positive for an hour. Reads
// log under `read-trace`, not `tool-call` (loop.ts), which no assertion here depends on.

const LOCATOR = '/var/folders/ab/T/reika-spill-123-cafe/grep-results-9f8e.txt';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}`, name, args };
}

function spillResult(payload: string): Message {
  return { role: 'tool', callId: 'c1', summary: 'Found 150 matches', payload };
}

const CAPPED_PAYLOAD =
  'src/a.ts:1: hit\n\n(Showing 100 of 150 matches. Full result saved to ' +
  LOCATOR +
  ' — read that path with offset/limit to page through it, or grep it to narrow. ' +
  'Do not re-run this search to see the rest.)';

describe('spilledPath', () => {
  it('extracts the locator from a capped result', () => {
    expect(spilledPath([spillResult(CAPPED_PAYLOAD)])).toBe(LOCATOR);
  });

  it('is null when no result was capped — the REIKA_SPILL-off shape', () => {
    expect(spilledPath([spillResult('src/a.ts:1: hit\nsrc/b.ts:2: hit')])).toBeNull();
  });

  it('is null when the capped result could not be saved', () => {
    const payload =
      'src/a.ts:1: hit\n\n(Showing 100 of 150 matches. The rest could not be saved — ' +
      'narrow the pattern or scope to see them.)';
    expect(spilledPath([spillResult(payload)])).toBeNull();
  });

  it('ignores assistant prose that happens to mention a path', () => {
    const messages: Message[] = [
      { role: 'assistant', content: `I could read ${LOCATOR} next.` },
      spillResult('no cap here'),
    ];
    expect(spilledPath(messages)).toBeNull();
  });
});

describe('readsSpill', () => {
  it('accepts a read of the locator, paged or not', () => {
    expect(readsSpill(call('read', { path: LOCATOR }), LOCATOR)).toBe(true);
    expect(readsSpill(call('read', { path: LOCATOR, offset: 300, limit: 100 }), LOCATOR)).toBe(
      true,
    );
  });

  it('accepts a grep scoped to the locator — the footer names both routes', () => {
    expect(readsSpill(call('grep', { pattern: 'FLAG_', path: LOCATOR }), LOCATOR)).toBe(true);
  });

  it('accepts a shell command that reads the artifact', () => {
    // `bash cat <locator>` is following the locator by a route the footer does not spell out.
    // Scoring it as "routed around it via bash" would invert the finding the fixture exists for.
    expect(readsSpill(call('bash', { command: `cat ${LOCATOR} | tail -50` }), LOCATOR)).toBe(true);
  });

  it('rejects the per-file narrowing that spill is supposed to replace', () => {
    expect(readsSpill(call('grep', { pattern: 'FLAG_', path: 'src/telemetry.ts' }), LOCATOR)).toBe(
      false,
    );
    expect(readsSpill(call('read', { path: 'src/telemetry.ts' }), LOCATOR)).toBe(false);
  });

  it('rejects a shell command that re-runs the search instead of reading the artifact', () => {
    const c = call('bash', { command: 'grep -r "FLAG_" src/ | sed \'s/:.*//\' | sort -u' });
    expect(readsSpill(c, LOCATOR)).toBe(false);
  });
});

describe('callsAfterSpill', () => {
  const messages: Message[] = [
    { role: 'user', content: 'list every file defining FLAG_' },
    { role: 'assistant', content: '', toolCalls: [call('grep', { pattern: 'FLAG_' })] },
    spillResult(CAPPED_PAYLOAD),
    { role: 'assistant', content: '', toolCalls: [call('read', { path: LOCATOR })] },
    { role: 'tool', callId: 'c2', summary: 'Read spill', payload: 'src/z.ts:9: hit' },
    { role: 'assistant', content: 'telemetry.ts and transport.ts' },
  ];

  it('excludes the call that produced the spill and keeps what follows', () => {
    const after = callsAfterSpill(messages, LOCATOR);
    expect(after.map(c => c.name)).toEqual(['read']);
  });

  it('is empty when the locator never appears in a result', () => {
    expect(callsAfterSpill(messages, '/tmp/other.txt')).toEqual([]);
  });
});

describe('existing helpers', () => {
  it('reads the last assistant message with content, skipping tool-call-only turns', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: '', toolCalls: [call('read', { path: 'a.ts' })] },
    ];
    expect(lastAssistantContent(messages)).toBe('first');
    expect(calledTool(messages, 'read')).toBe(true);
    expect(calledTool(messages, 'bash')).toBe(false);
  });
});
