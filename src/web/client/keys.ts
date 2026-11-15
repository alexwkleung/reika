// What a key in the input box does, and which numbered option a digit picks in a dialog. Pure, so
// the rules are tested without a browser.

export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  // An IME is composing: its Enter commits the composition and must never send.
  isComposing: boolean;
};

export type ComposerAction =
  | 'submit'
  | 'abort'
  | 'newline'
  | 'history-older'
  | 'history-newer'
  | 'complete-up'
  | 'complete-down'
  | 'complete-accept'
  | 'complete-close'
  | 'none';

export type ComposerContext = {
  text: string;
  busy: boolean;
  // A completion list is open: it owns ↑/↓, Tab, Enter and Escape, as in the TUI.
  completing: boolean;
  // The caret, with nothing selected, on the box's first or last line: ↑/↓ there walk the history
  // instead of moving between lines.
  atFirstLine: boolean;
  atLastLine: boolean;
};

const plain = (e: ComposerKey): boolean => !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

export function composerKeyAction(e: ComposerKey, ctx: ComposerContext): ComposerAction {
  if (e.isComposing) return 'none';
  if (ctx.completing) {
    if (e.key === 'ArrowUp' && plain(e)) return 'complete-up';
    if (e.key === 'ArrowDown' && plain(e)) return 'complete-down';
    if ((e.key === 'Tab' || e.key === 'Enter') && plain(e)) return 'complete-accept';
    if (e.key === 'Escape') return 'complete-close';
  }
  if (e.key === 'Enter' && plain(e)) {
    // The TUI's continuation: a trailing backslash becomes a line break instead of a send.
    if (ctx.text.endsWith('\\')) return 'newline';
    return ctx.text.trim() ? 'submit' : 'none';
  }
  if (e.key === 'ArrowUp' && plain(e) && ctx.atFirstLine) return 'history-older';
  if (e.key === 'ArrowDown' && plain(e) && ctx.atLastLine) return 'history-newer';
  // Escape stops a turn only from an empty box, so a half-typed prompt is never a stop by accident.
  if (e.key === 'Escape' && ctx.busy && ctx.text === '') return 'abort';
  return 'none';
}

// Where the caret sits, for the history rule: no selection, and no line break before (or after) it.
export function caretLines(
  text: string,
  start: number,
  end: number,
): { atFirstLine: boolean; atLastLine: boolean } {
  if (start !== end) return { atFirstLine: false, atLastLine: false };
  return {
    atFirstLine: !text.slice(0, start).includes('\n'),
    atLastLine: !text.slice(start).includes('\n'),
  };
}

// `1`–`9` picks that option, unless focus is in a text field (where the digit is text).
export function digitPick(key: string, inTextField: boolean, options: number): number | null {
  if (inTextField || !/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index < options ? index : null;
}

// A paste or drop that carries an image: refused, since the wire takes text only (#979).
export function carriesImage(
  items: Iterable<{ kind?: string; type: string }> | null | undefined,
): boolean {
  for (const item of items ?? []) if (item.type.startsWith('image/')) return true;
  return false;
}

export const IMAGES_UNSUPPORTED = 'Images are not supported in the browser yet.';
