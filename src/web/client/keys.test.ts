import { describe, expect, it } from 'vitest';
import { carriesImage, composerKeyAction, digitPick } from './keys.js';

const key = (k: string, over: Partial<Parameters<typeof composerKeyAction>[0]> = {}) => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  ...over,
});

describe('composerKeyAction', () => {
  it('Enter submits text, and does nothing for an empty or blank box', () => {
    expect(composerKeyAction(key('Enter'), 'hi', false)).toBe('submit');
    expect(composerKeyAction(key('Enter'), 'hi', true)).toBe('submit');
    expect(composerKeyAction(key('Enter'), '', false)).toBe('none');
    expect(composerKeyAction(key('Enter'), '  \n\t', false)).toBe('none');
  });

  it('Shift+Enter, modified Enter and an IME composition never submit', () => {
    expect(composerKeyAction(key('Enter', { shiftKey: true }), 'hi', false)).toBe('none');
    expect(composerKeyAction(key('Enter', { isComposing: true }), 'hi', false)).toBe('none');
    expect(composerKeyAction(key('Enter', { altKey: true }), 'hi', false)).toBe('none');
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), 'hi', false)).toBe('none');
    expect(composerKeyAction(key('Enter', { metaKey: true }), 'hi', false)).toBe('none');
  });

  it('Escape aborts only a busy turn from an empty box', () => {
    expect(composerKeyAction(key('Escape'), '', true)).toBe('abort');
    expect(composerKeyAction(key('Escape'), 'draft', true)).toBe('none');
    expect(composerKeyAction(key('Escape'), '', false)).toBe('none');
    expect(composerKeyAction(key('Escape', { isComposing: true }), '', true)).toBe('none');
  });

  it('other keys do nothing', () => {
    expect(composerKeyAction(key('a'), 'a', true)).toBe('none');
  });
});

describe('digitPick', () => {
  it('picks 1-9 within range, outside text fields', () => {
    expect(digitPick('1', false, 3)).toBe(0);
    expect(digitPick('3', false, 3)).toBe(2);
    expect(digitPick('4', false, 3)).toBeNull();
    expect(digitPick('0', false, 3)).toBeNull();
    expect(digitPick('1', true, 3)).toBeNull();
    expect(digitPick('a', false, 3)).toBeNull();
    expect(digitPick('9', false, 12)).toBe(8);
  });
});

describe('carriesImage', () => {
  it('spots an image among pasted or dropped items', () => {
    expect(carriesImage([{ type: 'text/plain' }, { type: 'image/png' }])).toBe(true);
    expect(carriesImage([{ type: 'text/plain' }])).toBe(false);
    expect(carriesImage(null)).toBe(false);
  });
});
