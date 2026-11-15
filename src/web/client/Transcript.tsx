import { memo, useMemo } from 'react';
import type { WireMessage } from '../protocol.js';
import { WorkedRow } from './blocks.js';
import { MessageRow } from './MessageRow.js';
import { buildTranscriptLog } from './transcriptlog.js';

// The committed rows. Memoised on the messages array, which the store keeps by identity on every
// live-only event, so the live region streaming below never re-renders this.
export const Transcript = memo(function Transcript({
  messages,
  idle,
}: {
  messages: WireMessage[];
  idle: boolean;
}) {
  const log = useMemo(() => buildTranscriptLog(messages), [messages]);
  return (
    <div className="transcript">
      {log.items.map(item =>
        item.kind === 'worked' ? (
          <WorkedRow key={item.key} durationMs={item.durationMs} />
        ) : (
          <MessageRow
            key={item.key}
            message={item.message}
            gap={item.ctx.gap}
            groupedReads={item.ctx.groupedReads}
          />
        ),
      )}
      {idle && log.held !== null ? <WorkedRow durationMs={log.held} /> : null}
    </div>
  );
});
