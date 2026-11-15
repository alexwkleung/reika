import { pasteMarkersIn, rememberPaste, type PastedText } from '../../ui/pastes.js';

// Large pastes, parked as the TUI parks them (#120): the box holds a `[Pasted text #N …]` marker
// and the text rides beside it on submit, so the server's questions read only the words typed
// (#448). The server renumbers each into its own store; these numbers only have to be unique in
// what this tab can see.

// The new marker's number is above every marker in `seen` (the box, the shared history) and every
// paste parked here, so a recalled server marker and a new one never share a string.
export function parkPaste(
  parked: PastedText[],
  seen: string[],
  text: string,
): { parked: PastedText[]; marker: string } {
  const known = [...parked, ...seen.flatMap(pasteMarkersIn).map(marker => ({ marker, text: '' }))];
  const { marker } = rememberPaste(known, text);
  return { parked: [...parked, { marker, text }], marker };
}

// What a submit carries: the parked pastes whose marker the text still holds.
export function pastesFor(text: string, parked: PastedText[]): PastedText[] {
  const live = new Set(pasteMarkersIn(text));
  return parked.filter(p => live.has(p.marker));
}

// Once the server took them it owns them (a recalled line carries its numbers), so a sent paste is
// dropped here; one still in the box stays.
export function afterSend(parked: PastedText[], sent: PastedText[], box: string): PastedText[] {
  const gone = new Set(sent.map(p => p.marker));
  const live = new Set(pasteMarkersIn(box));
  return parked.filter(p => !gone.has(p.marker) || live.has(p.marker));
}
