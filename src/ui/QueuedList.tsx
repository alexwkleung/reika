import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { QueuedMessage } from './queue.js';
import { queuedPreview } from './queue.js';

/** Ephemeral list of messages waiting for the current turn to finish.
 *  Sits directly above the input where the eye already is; disappears the
 *  moment the queue drains (scrollback receipts keep the record). */
export function QueuedList({ queue }: { queue: QueuedMessage[] }) {
  if (queue.length === 0) return null;
  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      {queue.map((msg, i) => (
        <Box key={i} width="100%">
          <Text wrap="wrap">
            <Text color={theme.muted}>[Queued] </Text>
            <Text>{queuedPreview(msg)}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
