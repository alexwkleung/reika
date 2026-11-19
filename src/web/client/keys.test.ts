import { describe, expect, it } from 'vitest';
import {
  caretLines,
  carriesImage,
  composerKeyAction,
  digitPick,
  type ComposerContext,
} from './keys.js';

const key = (k: string, over: Partial<Parameters<typeof composerKeyAction>[0]> = {}) => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  ...over,
});

describe('composerKeyAction', () => {
  const ctx = (over: Partial<ComposerContext> = {}): ComposerContext => ({
    text: '',
    busy: false,
    completing: false,
    atFirstLine: true,
    atLastLine: true,
    ...over,
  });

  it('Enter submits text, and does nothing for an empty or blank box', () => {
    expect(composerKeyAction(key('Enter'), ctx({ text: 'hi' }))).toBe('submit');
    expect(composerKeyAction(key('Enter'), ctx({ text: 'hi', busy: true }))).toBe('submit');
    expect(composerKeyAction(key('Enter'), ctx())).toBe('none');
    expect(composerKeyAction(key('Enter'), ctx({ text: '  \n\t' }))).toBe('none');
  });

  it('Enter after a trailing backslash is a line break, as in the TUI', () => {
    expect(composerKeyAction(key('Enter'), ctx({ text: 'first line\\' }))).toBe('newline');
  });

  it('Shift+Enter, modified Enter and an IME composition never submit', () => {
    const text = 'hi';
    expect(composerKeyAction(key('Enter', { shiftKey: true }), ctx({ text }))).toBe('none');
    expect(composerKeyAction(key('Enter', { isComposing: true }), ctx({ text }))).toBe('none');
    expect(composerKeyAction(key('Enter', { altKey: true }), ctx({ text }))).toBe('none');
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), ctx({ text }))).toBe('none');
    expect(composerKeyAction(key('Enter', { metaKey: true }), ctx({ text }))).toBe('none');
  });

  it('Escape aborts only a busy turn from an empty box', () => {
    expect(composerKeyAction(key('Escape'), ctx({ busy: true }))).toBe('abort');
    expect(composerKeyAction(key('Escape'), ctx({ text: 'draft', busy: true }))).toBe('none');
    expect(composerKeyAction(key('Escape'), ctx())).toBe('none');
    expect(composerKeyAction(key('Escape', { isComposing: true }), ctx({ busy: true }))).toBe(
      'none',
    );
  });

  it('↑ on the first line and ↓ on the last walk the history; elsewhere they move the caret', () => {
    expect(composerKeyAction(key('ArrowUp'), ctx())).toBe('history-older');
    expect(composerKeyAction(key('ArrowDown'), ctx())).toBe('history-newer');
    expect(composerKeyAction(key('ArrowUp'), ctx({ atFirstLine: false }))).toBe('none');
    expect(composerKeyAction(key('ArrowDown'), ctx({ atLastLine: false }))).toBe('none');
    expect(composerKeyAction(key('ArrowUp', { shiftKey: true }), ctx())).toBe('none');
  });

  it('an open completion list owns ↑/↓, Tab, Enter and Escape', () => {
    const open = ctx({ text: '/mo', completing: true, busy: true });
    expect(composerKeyAction(key('ArrowUp'), open)).toBe('complete-up');
    expect(composerKeyAction(key('ArrowDown'), open)).toBe('complete-down');
    expect(composerKeyAction(key('Tab'), open)).toBe('complete-accept');
    expect(composerKeyAction(key('Enter'), open)).toBe('complete-accept');
    expect(composerKeyAction(key('Escape'), { ...open, text: '' })).toBe('complete-close');
    expect(composerKeyAction(key('Tab'), ctx())).toBe('none');
  });

  it('other keys do nothing', () => {
    expect(composerKeyAction(key('a'), ctx({ text: 'a', busy: true }))).toBe('none');
  });
});

describe('caretLines', () => {
  it('reads the caret on the first and last line, and neither with a selection', () => {
    expect(caretLines('one', 1, 1)).toEqual({ atFirstLine: true, atLastLine: true });
    expect(caretLines('one\ntwo', 2, 2)).toEqual({ atFirstLine: true, atLastLine: false });
    expect(caretLines('one\ntwo', 5, 5)).toEqual({ atFirstLine: false, atLastLine: true });
    expect(caretLines('one', 0, 3)).toEqual({ atFirstLine: false, atLastLine: false });
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
