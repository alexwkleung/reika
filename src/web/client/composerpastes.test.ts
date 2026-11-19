import { describe, expect, it } from 'vitest';
import { PASTE_LINE_THRESHOLD } from '../../ui/pastes.js';
import { afterSend, parkPaste, pastesFor } from './composerpastes.js';

const big = (tag: string) => `${tag}\n`.repeat(PASTE_LINE_THRESHOLD);
const n = PASTE_LINE_THRESHOLD;

describe('parkPaste', () => {
  it('numbers above every marker in the box, the history and what is parked', () => {
    const seen = [`recalled [Pasted text #4 +${n} lines]`, 'plain'];
    const first = parkPaste([], seen, big('a'));
    expect(first.marker).toBe(`[Pasted text #5 +${n} lines]`);
    const second = parkPaste(first.parked, seen, big('b'));
    expect(second.marker).toBe(`[Pasted text #6 +${n} lines]`);
    expect(second.parked.map(p => p.text)).toEqual([big('a'), big('b')]);
  });

  it('starts at #1 with nothing seen', () => {
    expect(parkPaste([], [], big('a')).marker).toBe(`[Pasted text #1 +${n} lines]`);
  });
});

describe('pastesFor and afterSend', () => {
  it('sends only pastes still in the text, and keeps one still in the box after the send', () => {
    const a = parkPaste([], [], big('a'));
    const b = parkPaste(a.parked, [], big('b'));
    const text = `look ${a.marker}`;
    const sent = pastesFor(text, b.parked);
    expect(sent.map(p => p.marker)).toEqual([a.marker]);
    expect(afterSend(b.parked, sent, '')).toEqual([b.parked[1]]);
    expect(afterSend(b.parked, sent, `again ${a.marker}`)).toEqual(b.parked);
  });
});
