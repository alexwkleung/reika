import { describe, expect, it } from 'vitest';
import { buildTranscriptLog } from './transcriptlog.js';

describe('buildTranscriptLog interrupted turn', () => {
  it('carries the interruption onto the closing line, held and committed', () => {
    const aborted = {
      role: 'assistant' as const,
      content: '(aborted)',
      interrupted: true,
      durationMs: 3000,
    };
    expect(buildTranscriptLog([{ role: 'user', content: 'go' }, aborted]).held).toEqual({
      ms: 3000,
      interrupted: true,
    });
    const { items } = buildTranscriptLog([
      { role: 'user', content: 'go' },
      aborted,
      { role: 'user', content: 'again' },
    ]);
    expect(items.find(i => i.kind === 'worked')).toMatchObject({
      durationMs: 3000,
      interrupted: true,
    });
  });
});
