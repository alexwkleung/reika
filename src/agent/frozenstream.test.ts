import { describe, expect, it } from 'vitest';
import { FROZEN_STREAM_CHARS, frozenStreamMessage } from './frozenstream.js';

const plain = { note: false, nested: false };

describe('frozenStreamMessage', () => {
  it('is null when nothing had streamed, whitespace included', () => {
    expect(frozenStreamMessage({ content: '', reasoning: '', ...plain })).toBeNull();
    expect(frozenStreamMessage({ content: '  \n', reasoning: '\t', ...plain })).toBeNull();
  });

  it('keeps content alone, reasoning alone, or both, trimmed', () => {
    expect(frozenStreamMessage({ content: ' the reply ', reasoning: '', ...plain })).toEqual({
      role: 'assistant',
      content: 'the reply',
      discarded: 'stream',
    });
    expect(frozenStreamMessage({ content: '', reasoning: 'thinking', ...plain })).toEqual({
      role: 'assistant',
      content: '',
      reasoning: 'thinking',
      discarded: 'stream',
    });
    expect(frozenStreamMessage({ content: 'reply', reasoning: 'thinking', ...plain })).toEqual({
      role: 'assistant',
      content: 'reply',
      reasoning: 'thinking',
      discarded: 'stream',
    });
  });

  it('keeps only the tail of a stream over the cap', () => {
    const long = 'a'.repeat(FROZEN_STREAM_CHARS) + 'the end';
    const frozen = frozenStreamMessage({ content: long, reasoning: long, ...plain });
    expect(frozen).toMatchObject({ role: 'assistant' });
    const msg = frozen as { content: string; reasoning: string };
    expect(msg.content).toHaveLength(FROZEN_STREAM_CHARS);
    expect(msg.content.endsWith('the end')).toBe(true);
    expect(msg.reasoning).toHaveLength(FROZEN_STREAM_CHARS);
  });

  it('marks a compaction note and a subagent stream', () => {
    expect(
      frozenStreamMessage({ content: 'note', reasoning: '', note: true, nested: false }),
    ).toMatchObject({ discarded: 'note' });
    const nested = frozenStreamMessage({ content: 'x', reasoning: '', note: false, nested: true });
    expect(nested).toMatchObject({ discarded: 'stream', nested: true });
    expect(frozenStreamMessage({ content: 'x', reasoning: '', ...plain })).not.toHaveProperty(
      'nested',
    );
  });
});
