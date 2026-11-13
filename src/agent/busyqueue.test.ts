import { describe, it, expect } from 'vitest';
import {
  canDrain,
  queuedMessage,
  queuedPreview,
  queueReceipt,
  takeNext,
  type QueuedMessage,
} from './busyqueue.js';
import type { ImageAttachment } from './attachments.js';

const image: ImageAttachment = { marker: '[Image #1]', text: 'img', source: 'clipboard' };
const queued = (content: string, images?: ImageAttachment[]): QueuedMessage => ({
  content,
  ...(images ? { images } : {}),
  answers: {},
});

describe('queuedMessage', () => {
  it('holds nothing for a prompt with no text', () => {
    expect(queuedMessage('', [], {})).toBeNull();
    expect(queuedMessage('', [image], {})).toBeNull();
  });

  it('keeps an image whose marker is in the text', () => {
    expect(queuedMessage('look [Image #1]', [image], {})).toEqual({
      content: 'look [Image #1]',
      images: [image],
      answers: {},
    });
  });

  it('leaves out an image whose marker was deleted', () => {
    expect(queuedMessage('never mind', [image], {})).toEqual({
      content: 'never mind',
      answers: {},
    });
  });

  it('carries the answers taken at keypress', () => {
    expect(queuedMessage('review pr 4', [], { skill: null, fetchUrls: true })).toEqual({
      content: 'review pr 4',
      answers: { skill: null, fetchUrls: true },
    });
  });
});

describe('canDrain', () => {
  const open = { idle: true, dialogOpen: false, resuming: false, replaying: false };

  it('drains when idle with nothing in the way', () => {
    expect(canDrain(open)).toBe(true);
  });

  it('waits on a running turn, an open dialog, a resume and a replay still being submitted', () => {
    expect(canDrain({ ...open, idle: false })).toBe(false);
    expect(canDrain({ ...open, dialogOpen: true })).toBe(false);
    expect(canDrain({ ...open, resuming: true })).toBe(false);
    expect(canDrain({ ...open, replaying: true })).toBe(false);
  });
});

describe('takeNext', () => {
  it('returns null for an empty queue', () => {
    expect(takeNext([])).toBeNull();
  });

  it('takes the oldest message and leaves the rest in order', () => {
    const [a, b, c] = [queued('a'), queued('b'), queued('c')];
    expect(takeNext([a, b, c])).toEqual({ next: a, rest: [b, c] });
  });
});

describe('queuedPreview', () => {
  it('returns the content unchanged for a single line', () => {
    expect(queuedPreview(queued('fix the tests'))).toBe('fix the tests');
  });

  it('folds multiline pastes to the first line with a count of the rest', () => {
    expect(queuedPreview(queued('first\nsecond\nthird'))).toBe('first (+2 lines)');
    expect(queuedPreview(queued('first\nsecond'))).toBe('first (+1 line)');
  });

  it('does not count blank lines in the fold', () => {
    expect(queuedPreview(queued('first\n\nsecond\n'))).toBe('first (+1 line)');
  });

  it('puts the image hint after the fold count', () => {
    expect(queuedPreview(queued('first\nsecond', [image]))).toBe('first (+1 line) [image]');
  });

  it('appends an image hint when images are attached', () => {
    expect(queuedPreview(queued('look at this', [image]))).toBe('look at this [image]');
  });

  it('handles an empty message with only an image', () => {
    expect(queuedPreview(queued('', [image]))).toBe(' [image]');
  });
});

describe('queueReceipt', () => {
  it('prefixes the message with [Queued]', () => {
    expect(queueReceipt(queued('fix the tests'))).toBe('[Queued] fix the tests');
  });

  it('drops multiline messages below the tag so their lines share a left edge', () => {
    expect(queueReceipt(queued('first\nsecond'))).toBe('[Queued]\nfirst\nsecond');
  });

  it('keeps the image hint on the tag line for multiline messages', () => {
    expect(queueReceipt(queued('first\n\nsecond', [image]))).toBe(
      '[Queued] [image]\nfirst\n\nsecond',
    );
  });

  it('notes image attachments after the tag', () => {
    expect(queueReceipt(queued('look', [image]))).toBe('[Queued] [image] look');
  });
});
