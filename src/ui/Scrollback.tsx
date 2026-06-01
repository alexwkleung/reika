import React from 'react';
import { Box, Static, Text } from 'ink';
import type { Message } from '../types.js';
import { renderMarkdown, stripReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { DiffView } from './DiffView.js';
import { Header } from './Header.js';

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
    return <UserBubble text={msg.display ?? msg.content} />;
  }
  if (msg.role === 'header') {
    return <Header model={msg.model} cwd={msg.cwd} />;
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
        {msg.sources && msg.sources.length > 0 ? (
          <Box marginTop={1}>
            <Text color={theme.tool}>{`Sources: ${msg.sources.join(', ')}`}</Text>
          </Box>
        ) : null}
        {msg.durationMs !== undefined ? (
          <Box marginTop={1}>
            <Text color={theme.muted}>{`Worked for ${formatDuration(msg.durationMs)}`}</Text>
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

// Grey "bubble" for the user's message: an accent bar down the left, one space
// of horizontal padding on each side, and a blank background row above/below so
// the box has a little vertical breathing room.
function UserBubble({ text }: { text: string }) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2); // App applies paddingX={1} on each side.
  const contentW = Math.max(1, avail - 4); // ' ▎ ' gutter (3) + trailing space (1).
  const lines = wrapText(text, contentW);
  const rows = ['', ...lines, '']; // blank top/bottom rows = vertical padding.

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((line, i) => (
        <Text key={i} backgroundColor={theme.userBg}>
          <Text> </Text>
          <Text bold color={theme.accent}>
            ▎
          </Text>
          <Text bold>{` ${line.padEnd(contentW)} `}</Text>
        </Text>
      ))}
    </Box>
  );
}

// Word-wrap to a column width, hard-splitting any token longer than the width.
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (let word of raw.split(' ')) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
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
