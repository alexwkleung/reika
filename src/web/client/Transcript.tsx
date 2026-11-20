import { memo, useMemo } from 'react';
import type { WireMessage, WireState } from '../protocol.js';
import { WorkedRow } from './blocks.js';
import { MessageRow } from './MessageRow.js';
import { buildTranscriptLog } from './transcriptlog.js';

// The committed rows. Memoised on the messages array, which the store keeps by identity on every
// live-only event, so the live region streaming below never re-renders this.
export const Transcript = memo(function Transcript({
  messages,
  idle,
  offScreen = null,
}: {
  messages: WireMessage[];
  idle: boolean;
  offScreen?: WireState['offScreen'];
}) {
  const log = useMemo(() => buildTranscriptLog(messages), [messages]);
  const empty = useMemo(
    () => !messages.some(m => (m.role === 'user' && !m.meta) || m.role === 'shell'),
    [messages],
  );
  return (
    <div className="transcript">
      {log.items.map(item =>
        item.kind === 'worked' ? (
          <WorkedRow key={item.key} durationMs={item.durationMs} interrupted={item.interrupted} />
        ) : (
          <MessageRow
            key={item.key}
            message={item.message}
            gap={item.ctx.gap}
            groupedReads={item.ctx.groupedReads}
          />
        ),
      )}
      {idle && log.held !== null ? (
        <WorkedRow durationMs={log.held.ms} interrupted={log.held.interrupted} />
      ) : null}
      {empty && offScreen ? <OtherSideNote side={offScreen.side} /> : null}
    </div>
  );
});

// A session's chat and its agent work are two conversations in one file, and a mode switch shows
// one of them. Seen from the other side, an empty screen read as the session being wiped.
function OtherSideNote({ side }: { side: 'agent' | 'chat' }) {
  const here = side === 'chat' ? 'an agent' : 'a chat';
  return (
    <p className="other-side-note">
      This conversation is in {side} mode. Switch to {side} to see it, or send a message to start{' '}
      {here} conversation in this session.
    </p>
  );
}
