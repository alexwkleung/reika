import type { ImageAttachment } from './attachments.js';
import type { ImplementMode } from './turncommands.js';

// What the user answered before a prompt was sent, each taken at keypress while they were present.
// An absent field means that question never came up.
export type SubmitAnswers = {
  // The skill confirm (#425): the skill to apply, or null for "send as typed".
  skill?: string | null;
  // The pasted-link confirm (#448): fetch the links this prompt carries, or leave them.
  fetchUrls?: boolean;
  // /implement's mode picker (#561).
  implementMode?: ImplementMode;
};

// A prompt held while a turn runs (or the session boots), replayed through the ordinary submit
// path once idle. It carries its answers so the replay never asks with nobody at the desk.
export type QueuedMessage = {
  content: string;
  images?: ImageAttachment[];
  answers: SubmitAnswers;
};

// Null when there is no text to hold. An image whose marker was deleted from the text is left
// out, the rule a prompt sent while idle follows (#959).
export function queuedMessage(
  content: string,
  images: ImageAttachment[],
  answers: SubmitAnswers,
): QueuedMessage | null {
  if (!content) return null;
  const live = images.filter(img => content.includes(img.marker));
  return { content, ...(live.length > 0 ? { images: live } : {}), answers };
}

// A replay under an open dialog could open a second one over it, and one during a resume would
// land in the conversation being replaced. A replay stays idle while its input is built, so the
// next entry waits for it too: taken then, it would be refused as a double submit and lost (#958).
export function canDrain(state: {
  idle: boolean;
  dialogOpen: boolean;
  resuming: boolean;
  replaying: boolean;
}): boolean {
  return state.idle && !state.dialogOpen && !state.resuming && !state.replaying;
}

export function takeNext(
  queue: QueuedMessage[],
): { next: QueuedMessage; rest: QueuedMessage[] } | null {
  if (queue.length === 0) return null;
  const [next, ...rest] = queue;
  return { next, rest };
}

/**
 * Single-line preview for the ephemeral queued list above the input.
 * Multiline pastes collapse to their first line with a `(+N lines)` count —
 * without it a lone first line reads as chopped off rather than folded.
 * Blank lines aren't counted; image attachments surface as an `[image]` hint.
 */
export function queuedPreview(msg: QueuedMessage): string {
  const [firstLine = '', ...rest] = msg.content.split('\n');
  const more = rest.filter(line => line.trim() !== '').length;
  const fold = more > 0 ? ` (+${more} ${more === 1 ? 'line' : 'lines'})` : '';
  const imageHint = msg.images?.length ? ' [image]' : '';
  return `${firstLine}${fold}${imageHint}`;
}

/**
 * Persistent scrollback receipt emitted when a message is queued, so the
 * capture survives scrollback (the ephemeral list vanishes once the queue
 * drains). Full content is kept — this doubles as the record of what ran.
 * Single-line messages sit inline after the tag; multiline ones start on
 * the line below it so every line of the message shares one left edge.
 */
export function queueReceipt(msg: QueuedMessage): string {
  const tag = msg.images?.length ? '[Queued] [image]' : '[Queued]';
  const sep = msg.content.includes('\n') ? '\n' : ' ';
  return `${tag}${sep}${msg.content}`;
}
