import React from 'react';
import { Box, Static, Text } from 'ink';
import type { Message } from '../types.js';

export function Scrollback({
  messages,
  streaming,
  streamingReasoning,
}: {
  messages: Message[];
  streaming: string;
  streamingReasoning: string;
}) {
  return (
    <>
      <Static items={messages}>
        {(msg, i) => <MessageView key={i} msg={msg} />}
      </Static>
      {streamingReasoning ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`▸ ${streamingReasoning}`}</Text>
        </Box>
      ) : null}
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
      <Box flexDirection="row" marginTop={1}>
        <Text bold>{'▎ '}</Text>
        <Text bold>{msg.content}</Text>
      </Box>
    );
  }
  if (msg.role === 'assistant') {
    const isTerminal = !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0);
    const reasoningText = msg.reasoning
      ? isTerminal
        ? msg.reasoning
        : reasoningPreview(msg.reasoning)
      : null;
    return (
      <Box flexDirection="column" marginTop={1}>
        {reasoningText ? <Text dimColor>{`▸ ${reasoningText}`}</Text> : null}
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
  if (msg.role === 'error') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Error</Text>
        <Text>{msg.content}</Text>
      </Box>
    );
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

function reasoningPreview(r: string): string {
  const firstLine = r.split('\n').find(l => l.trim().length > 0) ?? '';
  return truncate(firstLine.trim(), 100);
}
