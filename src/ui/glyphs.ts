// Which set of ornaments (display/glyphs.ts) the terminal gets: the basic set is for a font that
// cannot draw the unicode one. The Linux kernel console holds at most 512 glyphs, and the fonts
// distros ship there cover WGL4:
// box lines, blocks, arrows, dashes, `…`, `·`, `•`, `●` — but not braille, dingbats, the rounded
// box corners or U+23FA, which draw as a replacement diamond. Only those are swapped; everything
// already in WGL4 is left as is, so the basic set changes as little as it can.
//
// Detected from TERM rather than probed: there is no query a terminal answers with "can draw
// this glyph". `REIKA_BASIC_GLYPHS=1` forces it for a terminal detection misses (an old Windows
// console font), `0` turns it off.
import { basicGlyphs, unicodeGlyphs, type Glyphs } from '../display/glyphs.js';

export type { Glyphs };

export function wantsBasicGlyphs(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.REIKA_BASIC_GLYPHS;
  if (flag === '1') return true;
  if (flag === '0') return false;
  const term = env.TERM ?? '';
  return term === 'linux' || /^vt\d/.test(term);
}

export function glyphsFor(basicSet: boolean): Glyphs {
  return basicSet ? basicGlyphs : unicodeGlyphs;
}

export const glyphs: Glyphs = glyphsFor(wantsBasicGlyphs());
