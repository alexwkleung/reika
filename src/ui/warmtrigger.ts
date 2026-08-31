import { hasImageMarker } from '../agent/attachments.js';
import { hasBareImagePath } from '../agent/mentions.js';
import { hasPasteMarker } from './pastes.js';

// When a buffer edit is worth spending a speculative prefix warm on (#81, REIKA_WARM).
//
// The warm fires once, on the edge into a prompt, and reserves a fixed 512-token allowance for
// the user message it can't see yet (USER_MSG_ALLOWANCE_TOKENS in agent/warm.ts). Both of those
// assumptions break for the openings below, so none of them counts as a prompt:
//
//   '/'  a slash command — handled locally, it never reaches the model at all.
//   '@'  a file mention — expands at submit into up to 50KB per file (agent/mentions.ts).
//   a bare image path — a file dragged into the terminal, which expands into an OCR'd block
//        of up to 20KB with no '@' to announce it (agent/mentions.ts). Checked explicitly
//        rather than left to the '/' rule: a dropped path is usually absolute, so it happens
//        to look like a command, and that coincidence shouldn't be what covers it.
//   [Pasted text #N …], [Image N]  markers standing in for text parked out of the buffer,
//        spliced back in at submit (ui/pastes.ts, agent/attachments.ts).
//
// The expanding cases aren't just larger than the allowance, they're the ones most likely
// to push the real submit into compaction — which rewrites mid-history and throws away exactly
// the prefix the warm heated. So the warm waits for an edit that leaves ordinary prose in the
// box, and a prompt built around a mention or an attachment simply doesn't get one.
export function isWarmableInput(value: string): boolean {
  if (value === '') return false;
  if (value.startsWith('/') || value.startsWith('@')) return false;
  return !hasPasteMarker(value) && !hasImageMarker(value) && !hasBareImagePath(value);
}

// Whether a buffer edit is the moment to fire the warm: the transition into a prompt. Both
// halves read only the buffer in front of them, so nothing latches — backspacing a warmed
// prompt away and typing '@' leaves the edit non-warmable on both sides, exactly as if '@'
// had been the session's first keystroke. Clearing the box and typing prose re-arms, which is
// the retry path a failed warm relies on (agent/warm.ts keeps no completedKey for those).
export function isWarmEdge(previous: string, next: string): boolean {
  return !isWarmableInput(previous) && isWarmableInput(next);
}
