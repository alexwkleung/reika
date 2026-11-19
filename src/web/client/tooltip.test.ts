import { describe, expect, it } from 'vitest';
import { placeTip, tip } from './Tooltip.js';

describe('tip', () => {
  it('draws the text and describes the element, instead of a browser title', () => {
    expect(tip('Decode speed')).toEqual({
      'data-tip': 'Decode speed',
      'aria-description': 'Decode speed',
    });
    expect(tip(null)).toEqual({});
    expect(tip('')).toEqual({});
  });

  it('adds no description where it would repeat a name or the cut text itself', () => {
    expect(tip('Hide history', { aria: false })).toEqual({ 'data-tip': 'Hide history' });
    expect(tip('A long title', { cut: '.t' })).toEqual({
      'data-tip': 'A long title',
      'data-tip-cut': '.t',
    });
  });
});

describe('placeTip', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 100, height: 24 };

  it('sits centred above its element', () => {
    expect(placeTip({ left: 450, top: 400, bottom: 420, width: 100 }, size, viewport)).toEqual({
      left: 450,
      top: 400 - 6 - 24,
    });
  });

  it('goes below when the top of the window leaves no room', () => {
    expect(placeTip({ left: 450, top: 10, bottom: 40, width: 100 }, size, viewport).top).toBe(46);
  });

  it('sits beside its element when asked, clear of a stacked neighbour', () => {
    expect(placeTip({ left: 10, top: 46, bottom: 78, width: 32 }, size, viewport, 'right')).toEqual(
      { left: 10 + 32 + 6, top: 62 - 12 },
    );
  });

  it('stays inside the window at either side', () => {
    expect(placeTip({ left: 0, top: 400, bottom: 420, width: 20 }, size, viewport).left).toBe(8);
    expect(placeTip({ left: 990, top: 400, bottom: 420, width: 10 }, size, viewport).left).toBe(
      1000 - 100 - 8,
    );
  });
});
