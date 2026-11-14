import type { Message } from '../types.js';

// A frozen stream's kept tail: well past what a viewport-tall live block can draw.
export const FROZEN_STREAM_CHARS = 16000;

// What a loop-break recovery leaves of the live stream it cut (#55): frozen into the scrollback
// where it stood rather than erased, so the frame does not drop by the block's height under a
// one-line notice. Only the tail is kept, since a cut spiral can run to tens of thousands of chars
// and the block only ever drew its end. Null when nothing had streamed.
export function frozenStreamMessage(stream: {
  content: string;
  reasoning: string;
  // The compaction note round (#280) was streaming, not an ordinary reply.
  note: boolean;
  // A subagent owned the stream (#342).
  nested: boolean;
}): Message | null {
  const reasoning = stream.reasoning.trim();
  const content = stream.content.trim();
  if (!reasoning && !content) return null;
  return {
    role: 'assistant',
    content: content.slice(-FROZEN_STREAM_CHARS),
    ...(reasoning ? { reasoning: reasoning.slice(-FROZEN_STREAM_CHARS) } : {}),
    discarded: stream.note ? 'note' : 'stream',
    ...(stream.nested ? { nested: true } : {}),
  };
}
