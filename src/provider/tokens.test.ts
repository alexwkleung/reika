import { describe, expect, it } from 'vitest';
import type { Message, Tool } from '../types.js';
import { estimateTokens, estimateRequestTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up partial tokens (~4 chars/token)', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateRequestTokens', () => {
  it('counts the system prompt even with empty history', () => {
    const small = estimateRequestTokens('sys', [], []);
    const large = estimateRequestTokens('sys'.repeat(100), [], []);
    expect(large).toBeGreaterThan(small);
  });

  it('grows as history grows', () => {
    const base: Message[] = [{ role: 'user', content: 'hi' }];
    const more: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a long reply '.repeat(50) },
    ];
    expect(estimateRequestTokens('sys', more, [])).toBeGreaterThan(
      estimateRequestTokens('sys', base, []),
    );
  });

  it('accounts for tool definitions', () => {
    const tool: Tool = {
      name: 'read',
      description: 'read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async () => ({ summary: '' }),
    };
    expect(estimateRequestTokens('sys', [], [tool])).toBeGreaterThan(
      estimateRequestTokens('sys', [], []),
    );
  });

  it('reflects payload aging: stale tool payloads cost less than fresh ones', () => {
    const big = 'X'.repeat(4000);
    // Fresh: tool block is trailing, so payload is included.
    const fresh: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
      { role: 'tool', callId: 'c1', summary: 'read', payload: big },
    ];
    // Stale: a later user turn pushes the tool block out of the fresh window.
    const stale: Message[] = [...fresh, { role: 'user', content: 'next' }];
    expect(estimateRequestTokens('sys', stale, [])).toBeLessThan(
      estimateRequestTokens('sys', fresh, []),
    );
  });
});
