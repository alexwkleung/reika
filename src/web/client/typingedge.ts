import { MAX_COMPLETE_CHARS } from '../protocol.js';
import { hasPasteMarker } from '../../ui/pastes.js';

// When the box tells the server a prompt has begun, so it can warm the engine's cache (#998). The
// TUI's `isWarmEdge`, minus the bare-image-path check, which needs Node: the server applies the
// whole rule again, so a looser edge here only costs a no-op message.
function looksLikePrompt(text: string): boolean {
  if (text === '' || text.startsWith('/') || text.startsWith('@')) return false;
  return !hasPasteMarker(text);
}

export function isTypingEdge(previous: string, next: string): boolean {
  return next.length <= MAX_COMPLETE_CHARS && !looksLikePrompt(previous) && looksLikePrompt(next);
}
