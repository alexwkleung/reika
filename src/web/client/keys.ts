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

export type ComposerAction = 'submit' | 'abort' | 'none';

export function composerKeyAction(e: ComposerKey, text: string, busy: boolean): ComposerAction {
  if (e.isComposing) return 'none';
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    return text.trim() ? 'submit' : 'none';
  }
  // Escape stops a turn only from an empty box, so a half-typed prompt is never a stop by accident.
  if (e.key === 'Escape' && busy && text === '') return 'abort';
  return 'none';
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
