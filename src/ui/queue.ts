import type { ImageAttachment } from '../agent/attachments.js';
import type { ImplementMode } from './commands.js';

/**
 * A user message captured while the agent is busy (or the session is still
 * booting). Content is always plain text — queued messages are submitted
 * through the normal `onSubmit` path once the current turn ends.
 */
export type QueuedMessage = {
  content: string;
  images?: ImageAttachment[];
  // The skill confirm's answer, taken at keypress while the user was present (#425): the skill
  // to apply when this replays, or null for "send as typed". Absent when no dialog fired.
  skill?: string | null;
  // The pasted-link confirm's answer (#448), taken the same way: fetch the links this prompt
  // carries, or leave them. Absent when the prompt's links needed no asking.
  fetchUrls?: boolean;
  // /implement's mode picker answer (#561), taken the same way. Absent when no dialog fired.
  implementMode?: ImplementMode;
};

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
