// Large pastes never enter the input buffer verbatim (issue #120). The input box is part of
// Ink's dynamic frame, and once that frame is as tall as the viewport Ink switches to its
// full-repaint path — including `\x1b[3J`, which wipes native scrollback — on every render.
// The cursor blink alone renders twice a second, so a pasted wall of text leaves the TUI
// unusable until restart. The buffer holds a short `[Pasted text #N +412 lines]` marker
// instead; the real text is parked here and spliced back in at submit.

// A paste at or above either bound becomes a marker. Lines is the bound that matters (rows are
// what overflow the frame); the char bound catches one enormous line, which wraps to just as
// many rows. Both are well under a small terminal's height so the box stays comfortable.
export const PASTE_LINE_THRESHOLD = 12;
export const PASTE_CHAR_THRESHOLD = 1500;

// Pastes are kept for the whole session (a history-recalled marker must still expand), so the
// store is bounded by total text rather than by turn. Oldest are dropped first; a marker whose
// text has been evicted stays literal, which is honest — it still reads as a paste.
export const MAX_PASTE_STORE_CHARS = 4_000_000;

export type PastedText = { marker: string; text: string };

// Only ever matches markers this module minted: the id is what maps back to the text, and the
// size is free-form so it can describe lines or chars.
const MARKER_RE = /\[Pasted text #\d+ \+[^\]\n]+\]/g;

export function isLargePaste(text: string): boolean {
  return countLines(text) >= PASTE_LINE_THRESHOLD || text.length >= PASTE_CHAR_THRESHOLD;
}

// Returns the marker to insert in the buffer alongside the updated store.
export function rememberPaste(
  pastes: PastedText[],
  text: string,
): { pastes: PastedText[]; marker: string } {
  const kept = [...pastes, { marker: nextMarker(pastes, text), text }];
  let total = kept.reduce((n, p) => n + p.text.length, 0);
  while (kept.length > 1 && total > MAX_PASTE_STORE_CHARS) {
    total -= kept.shift()!.text.length;
  }
  return { pastes: kept, marker: kept[kept.length - 1].marker };
}

// Splice every live marker back into the text the model receives. One pass, so text a paste
// contains can never be re-read as another paste's marker. A marker with no backing text is
// left alone — the user deleted it, or it outlived the store.
export function expandPastes(input: string, pastes: PastedText[]): string {
  if (pastes.length === 0) return input;
  const byMarker = new Map(pastes.map(p => [p.marker, p.text]));
  return input.replace(MARKER_RE, m => byMarker.get(m) ?? m);
}

function nextMarker(pastes: PastedText[], text: string): string {
  const used = pastes.map(p => Number(/#(\d+)/.exec(p.marker)?.[1] ?? 0));
  const id = Math.max(0, ...used) + 1;
  const lines = countLines(text);
  // A one-line paste is here because of its length, so "+1 line" would hide exactly the thing
  // that made it big.
  const size = lines > 1 ? `${lines} lines` : `${text.length} chars`;
  return `[Pasted text #${id} +${size}]`;
}

function countLines(text: string): number {
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
