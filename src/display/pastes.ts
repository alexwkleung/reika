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

// Whether the buffer still stands in for parked text. Mirrors hasImageMarker (agent/
// attachments.ts) — lets a caller tell "this is what the user typed" from "this expands into
// something much bigger at submit" without expanding anything.
export function hasPasteMarker(input: string): boolean {
  MARKER_RE.lastIndex = 0;
  return MARKER_RE.test(input);
}

// Every marker the text holds, in order, repeats included. A fresh regex: matchAll starts at the
// shared one's lastIndex, which `hasPasteMarker` leaves set.
export function pasteMarkersIn(text: string): string[] {
  return [...text.matchAll(new RegExp(MARKER_RE.source, 'g'))].map(m => m[0]);
}

// Exactly one marker this module could have minted, and nothing around it.
export function isPasteMarker(text: string): boolean {
  return new RegExp(`^${MARKER_RE.source}$`).test(text);
}

// Takes another front end's pastes into this store (a browser tab's, #584): each marker the text
// still holds gets a marker of this store's, in one pass, so a renumbered marker can never be
// renumbered again by a later one. A marker the text holds but `incoming` does not name is left as
// it is: it is this store's own, from a recalled line. Incoming pastes the text no longer holds are
// not kept, or they would push live ones out.
export function adoptPastes(
  pastes: PastedText[],
  text: string,
  incoming: PastedText[],
): { pastes: PastedText[]; text: string } {
  if (incoming.length === 0) return { pastes, text };
  const byMarker = new Map(incoming.map(p => [p.marker, p.text]));
  const renamed = new Map<string, string>();
  let store = pastes;
  for (const marker of pasteMarkersIn(text)) {
    const pasted = byMarker.get(marker);
    if (pasted === undefined || renamed.has(marker)) continue;
    const kept = rememberPaste(store, pasted);
    store = kept.pastes;
    renamed.set(marker, kept.marker);
  }
  return { pastes: store, text: text.replace(MARKER_RE, m => renamed.get(m) ?? m) };
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
