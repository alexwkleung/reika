import type { ImageAttachment } from '../agent/attachments.js';

/**
 * A user message captured while the agent is busy (or the session is still
 * booting). Content is always plain text — queued messages are submitted
 * through the normal `onSubmit` path once the current turn ends.
 */
export type QueuedMessage = {
  content: string;
  images?: ImageAttachment[];
};

/**
 * Single-line preview for the ephemeral queued list above the input.
 * Multiline pastes collapse to their first line; image attachments surface
 * as an `[image]` hint.
 */
export function queuedPreview(msg: QueuedMessage): string {
  const firstLine = msg.content.split('\n', 1)[0] ?? '';
  const imageHint = msg.images?.length ? ' [image]' : '';
  return `${firstLine}${imageHint}`;
}

/**
 * Persistent scrollback receipt emitted when a message is queued, so the
 * capture survives scrollback (the ephemeral list vanishes once the queue
 * drains). Full content is kept — this doubles as the record of what ran.
 */
export function queueReceipt(msg: QueuedMessage): string {
  const imageHint = msg.images?.length ? '[image] ' : '';
  return `[Queued] ${imageHint}${msg.content}`;
}
