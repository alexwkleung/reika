// The ornaments both front ends draw: the TUI picks a set per terminal (ui/glyphs.ts), and the page
// always draws the unicode one (web/client/blocks.tsx).
import { BRAILLE_SPINNER } from './workingwords.js';

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

export const unicodeGlyphs: Glyphs = {
  call: '⏺︎',
  dialogCall: '⏺',
  toolResult: '↳',
  bar: '▎',
  notice: '❯',
  noticeWarn: '⟳',
  check: '✓',
  next: '▸',
  brand: '✿',
  spinner: BRAILLE_SPINNER,
  border: 'round',
};

export const basicGlyphs: Glyphs = {
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
