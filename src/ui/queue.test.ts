import { describe, it, expect } from 'vitest';
import { queuedPreview, queueReceipt } from './queue.js';

describe('queuedPreview', () => {
  it('returns the content unchanged for a single line', () => {
    expect(queuedPreview({ content: 'fix the tests' })).toBe('fix the tests');
  });

  it('folds multiline pastes to the first line with a count of the rest', () => {
    expect(queuedPreview({ content: 'first\nsecond\nthird' })).toBe('first (+2 lines)');
    expect(queuedPreview({ content: 'first\nsecond' })).toBe('first (+1 line)');
  });

  it('does not count blank lines in the fold', () => {
    expect(queuedPreview({ content: 'first\n\nsecond\n' })).toBe('first (+1 line)');
  });

  it('puts the image hint after the fold count', () => {
    expect(
      queuedPreview({
        content: 'first\nsecond',
        images: [{ marker: '[Image #1]', text: 'img', source: 'clipboard' }],
      }),
    ).toBe('first (+1 line) [image]');
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

  it('drops multiline messages below the tag so their lines share a left edge', () => {
    expect(queueReceipt({ content: 'first\nsecond' })).toBe('[Queued]\nfirst\nsecond');
  });

  it('keeps the image hint on the tag line for multiline messages', () => {
    expect(
      queueReceipt({
        content: 'first\n\nsecond',
        images: [{ marker: '[Image #1]', text: 'img', source: 'clipboard' }],
      }),
    ).toBe('[Queued] [image]\nfirst\n\nsecond');
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
