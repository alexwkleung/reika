// The ornaments the UI draws, with a basic set for terminals whose font cannot draw them. The
// Linux kernel console holds at most 512 glyphs, and the fonts distros ship there cover WGL4:
// box lines, blocks, arrows, dashes, `…`, `·`, `•`, `●` — but not braille, dingbats, the rounded
// box corners or U+23FA, which draw as a replacement diamond. Only those are swapped; everything
// already in WGL4 is left as is, so the basic set changes as little as it can.
//
// Detected from TERM rather than probed: there is no query a terminal answers with "can draw
// this glyph". `REIKA_BASIC_GLYPHS=1` forces it for a terminal detection misses (an old Windows
// console font), `0` turns it off.

export function wantsBasicGlyphs(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.REIKA_BASIC_GLYPHS;
  if (flag === '1') return true;
  if (flag === '0') return false;
  const term = env.TERM ?? '';
  return term === 'linux' || /^vt\d/.test(term);
}

export type Glyphs = {
  // Tool call and prose marker. U+23FA needs VS15 to stay one column (see Scrollback).
  call: string;
  // The same mark bare, for dialogs; syncframe restores VS15 at the stream.
  dialogCall: string;
  toolResult: string;
  bar: string;
  notice: string;
  noticeWarn: string;
  check: string;
  next: string;
  brand: string;
  spinner: readonly string[];
  border: 'round' | 'single';
};

const unicode: Glyphs = {
  call: '⏺︎',
  dialogCall: '⏺',
  toolResult: '↳',
  bar: '▎',
  notice: '❯',
  noticeWarn: '⟳',
  check: '✓',
  next: '▸',
  brand: '✿',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  border: 'round',
};

const basic: Glyphs = {
  call: '●',
  dialogCall: '●',
  toolResult: '└',
  bar: '│',
  notice: '›',
  noticeWarn: '!',
  check: '√',
  next: '►',
  brand: '*',
  spinner: ['|', '/', '-', '\\'],
  border: 'single',
};

export function glyphsFor(basicSet: boolean): Glyphs {
  return basicSet ? basic : unicode;
}

export const glyphs: Glyphs = glyphsFor(wantsBasicGlyphs());
