import React from 'react';
import { Box, Static, Text } from 'ink';
import type { Message } from '../types.js';

export function Scrollback({
  messages,
  streaming,
}: {
  messages: Message[];
  streaming: string;
}) {
  return (
    <>
      <Static items={messages}>
        {(msg, i) => <MessageView key={i} msg={msg} />}
      </Static>
      {streaming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{streaming}</Text>
          <Text dimColor>▌</Text>
        </Box>
      ) : null}
    </>
  );
}

function MessageView({ msg }: { msg: Message }) {
  if (msg.role === 'user') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{`> ${msg.content}`}</Text>
      </Box>
    );
  }
  if (msg.role === 'assistant') {
    return (
      <Box flexDirection="column" marginTop={1}>
        {msg.content ? <Text>{msg.content}</Text> : null}
        {msg.toolCalls?.map(tc => (
          <Text key={tc.id} dimColor>{`· ${tc.name}(${formatArgs(tc.args)})`}</Text>
        ))}
      </Box>
    );
  }
  if (msg.role === 'tool') {
    return <Text dimColor>{`  ↳ ${msg.summary}`}</Text>;
  }
  return null;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 60)}`)
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
