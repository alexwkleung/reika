import { describe, it, expect } from 'vitest';
import { queuedPreview, queueReceipt } from './queue.js';

describe('queuedPreview', () => {
  it('returns the content unchanged for a single line', () => {
    expect(queuedPreview({ content: 'fix the tests' })).toBe('fix the tests');
  });

  it('collapses multiline pastes to the first line', () => {
    expect(queuedPreview({ content: 'first\nsecond\nthird' })).toBe('first');
  });

  it('appends an image hint when images are attached', () => {
    expect(
      queuedPreview({
        content: 'look at this',
        images: [{ marker: '[Image #1]', text: 'img', source: 'clipboard' }],
      }),
    ).toBe('look at this [image]');
  });

  it('handles an empty message with only an image', () => {
    expect(
      queuedPreview({
        content: '',
        images: [{ marker: '[Image #1]', text: 'img', source: 'clipboard' }],
      }),
    ).toBe(' [image]');
  });
});

describe('queueReceipt', () => {
  it('prefixes the message with [Queued]', () => {
    expect(queueReceipt({ content: 'fix the tests' })).toBe('[Queued] fix the tests');
  });

  it('keeps the full content of multiline messages', () => {
    expect(queueReceipt({ content: 'first\nsecond' })).toBe('[Queued] first\nsecond');
  });

  it('notes image attachments after the tag', () => {
    expect(
      queueReceipt({
        content: 'look',
        images: [{ marker: '[Image #1]', text: 'img', source: 'clipboard' }],
      }),
    ).toBe('[Queued] [image] look');
  });
});
