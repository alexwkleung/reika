import React from 'react';
import { Box, Static, Text } from 'ink';
import type { Message } from '../types.js';
import { renderMarkdown, stripReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { DiffView } from './DiffView.js';

export function Scrollback({
  messages,
  streaming,
  streamingReasoning,
  streamingTool,
}: {
  messages: Message[];
  streaming: string;
  streamingReasoning: string;
  streamingTool: string;
}) {
  return (
    <>
      <Static items={messages}>{(msg, i) => <MessageView key={i} msg={msg} />}</Static>
      {streamingReasoning ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>{`▸ ${stripReasoningMarkdown(streamingReasoning)}`}</Text>
        </Box>
      ) : null}
      {streaming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{renderMarkdown(streaming)}</Text>
          <Text color={theme.muted}>▌</Text>
        </Box>
      ) : null}
      {streamingTool ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>{streamingTool}</Text>
        </Box>
      ) : null}
    </>
  );
}

function MessageView({ msg }: { msg: Message }) {
  const inner = renderMessage(msg);
  if (inner === null) return null;
  if ('nested' in msg && msg.nested) {
    return <Box marginLeft={4}>{inner}</Box>;
  }
  return inner;
}

function renderMessage(msg: Message): React.ReactElement | null {
  if (msg.role === 'user') {
    const display = msg.display ?? msg.content;
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text bold color={theme.accent}>
          {'▎ '}
        </Text>
        <Text bold>{display}</Text>
      </Box>
    );
  }
  if (msg.role === 'shell') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.success}>{'$ '}</Text>
          <Text>{msg.command}</Text>
        </Box>
        {msg.output ? <Text color={theme.muted}>{msg.output}</Text> : null}
      </Box>
    );
  }
  if (msg.role === 'assistant') {
    return (
      <Box flexDirection="column" marginTop={1}>
        {msg.reasoning ? (
          <Text color={theme.muted}>{`▸ ${stripReasoningMarkdown(msg.reasoning)}`}</Text>
        ) : null}
        {msg.content ? (
          <Box marginTop={msg.reasoning ? 1 : 0}>
            <Text>{renderMarkdown(msg.content)}</Text>
          </Box>
        ) : null}
        {msg.toolCalls?.map(tc => (
          <Box key={tc.id}>
            <Text color={theme.tool}>{`· ${tc.name}`}</Text>
            <Text color={theme.secondary}>{`(${formatArgs(tc.args)})`}</Text>
          </Box>
        ))}
        {msg.durationMs !== undefined ? (
          <Box marginTop={1}>
            <Text color={theme.muted}>{`worked for ${formatDuration(msg.durationMs)}`}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (msg.role === 'tool') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={theme.tool}>{'  ↳ '}</Text>
          <Text color={theme.secondary}>{msg.summary}</Text>
        </Box>
        {msg.diff ? (
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            <DiffView diff={msg.diff.text} path={msg.diff.path} maxWidth={diffViewWidth()} />
          </Box>
        ) : null}
        {msg.command ? (
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            <Box>
              <Text color={theme.success}>{'$ '}</Text>
              <Text>{msg.command.text}</Text>
            </Box>
            {msg.command.outputTail ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.muted}>{msg.command.outputTail}</Text>
                {msg.command.outputTruncated ? (
                  <Text color={theme.muted}>…(more output omitted)</Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    );
  }
  if (msg.role === 'error') {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="round"
        borderColor={theme.error}
        paddingX={1}
      >
        <Text bold color={theme.error}>
          Error
        </Text>
        <Text>{msg.content}</Text>
      </Box>
    );
  }
  if (msg.role === 'system') {
    // Color must be on the OUTER Text so wrapped continuation lines inherit it;
    // a colored inner Text loses its color on wrap because Ink falls back to the
    // outer's color. The accent marker overrides for its own segment.
    return (
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={theme.accent}>{'❯ '}</Text>
          {msg.content}
        </Text>
      </Box>
    );
  }
  return null;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 120)}`)
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Available width for diff content inside a tool-result. Subtracts App's
// paddingX={1} on each side (2) plus the tool-diff marginLeft={4} = 6.
function diffViewWidth(): number {
  return Math.max(20, (process.stdout.columns || 80) - 6);
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
