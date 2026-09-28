import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { glyphsFor, wantsBasicGlyphs } from './glyphs.js';

describe('wantsBasicGlyphs', () => {
  it('turns on for the Linux console and VT terminals', () => {
    expect(wantsBasicGlyphs({ TERM: 'linux' })).toBe(true);
    expect(wantsBasicGlyphs({ TERM: 'vt100' })).toBe(true);
    expect(wantsBasicGlyphs({ TERM: 'vt220' })).toBe(true);
  });

  it('stays off for terminals that draw the full set', () => {
    for (const TERM of [
      'xterm-256color',
      'xterm',
      'screen-256color',
      'tmux-256color',
      'xterm-kitty',
    ]) {
      expect(wantsBasicGlyphs({ TERM })).toBe(false);
    }
    expect(wantsBasicGlyphs({})).toBe(false);
  });

  it('lets the flag override detection both ways', () => {
    expect(wantsBasicGlyphs({ TERM: 'xterm-256color', REIKA_BASIC_GLYPHS: '1' })).toBe(true);
    expect(wantsBasicGlyphs({ TERM: 'linux', REIKA_BASIC_GLYPHS: '0' })).toBe(false);
  });
});

describe('basic glyph set', () => {
  const basic = glyphsFor(true);

  // WGL4 is what Linux console fonts carry; a glyph outside it draws as a replacement diamond.
  const WGL4_USED = new Set(['●', '└', '│', '›', '√', '►']);

  it('uses only ASCII and WGL4 glyphs', () => {
    const { spinner, border: _border, ...marks } = basic;
    for (const g of [...Object.values(marks), ...spinner]) {
      for (const ch of g) expect(ch.charCodeAt(0) < 0x80 || WGL4_USED.has(ch)).toBe(true);
    }
    expect(basic.border).toBe('single');
  });

  // Scrollback's hanging indents assume every marker is one column, drawn and measured.
  it('keeps every marker one column wide', () => {
    for (const g of [basic.call, basic.toolResult, basic.bar, basic.notice, basic.noticeWarn]) {
      expect(stringWidth(g)).toBe(1);
    }
  });
});
