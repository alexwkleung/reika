import { MAX_COMPLETE_CHARS, type WireCompletion } from '../protocol.js';

// When the box asks the server for a completion list, and how a picked item lands. The list itself
// is the server's (`computeSuggestions`, the TUI's own rule).

export type Completion = NonNullable<WireCompletion>;

// The only shapes computeSuggestions answers: a command line, or text ending in `@word`. Anything
// else would be a request per keystroke for a list that is always empty.
export function wantsCompletion(text: string): boolean {
  return (text.startsWith('/') && !text.includes('\n')) || /@\S*$/.test(text);
}

// Past the server's cap only the trailing `@word` matters, and its `partial` still names the end of
// the whole text.
export function completionRequestText(text: string): string {
  if (text.length <= MAX_COMPLETE_CHARS) return text;
  return /@\S*$/.exec(text)?.[0].slice(-MAX_COMPLETE_CHARS) ?? '';
}

// suggest.ts's acceptSuggestion, here so the page does not bundle the command table.
export function acceptCompletion(text: string, value: string, partial: string): string {
  return text.slice(0, text.length - partial.length) + value;
}

// `/name  —  what it does`: the name and its description as two parts, for two styles.
export function splitDisplay(display: string): { label: string; detail: string | null } {
  const at = display.indexOf('  —  ');
  if (at !== -1) return { label: display.slice(0, at), detail: display.slice(at + 5) };
  const group = /^(.*?) {2}\((.+)\)$/.exec(display);
  if (group) return { label: group[1], detail: group[2] };
  return { label: display, detail: null };
}
