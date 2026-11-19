import { describe, expect, it } from 'vitest';
import { isTypingEdge } from './typingedge.js';

describe('isTypingEdge (#998)', () => {
  it('fires on the edit that makes the box a prompt', () => {
    expect(isTypingEdge('', 'h')).toBe(true);
    expect(isTypingEdge('/mo', 'mo')).toBe(true);
  });

  it('stays quiet while a prompt grows, and for commands, mentions and paste markers', () => {
    expect(isTypingEdge('h', 'he')).toBe(false);
    expect(isTypingEdge('', '/')).toBe(false);
    expect(isTypingEdge('', '@src')).toBe(false);
    expect(isTypingEdge('', '[Pasted text #1 +40 lines]')).toBe(false);
  });
});
