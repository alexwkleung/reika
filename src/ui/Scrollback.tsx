import React from 'react';
import { Box, Static, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { Message } from '../types.js';
import { renderMarkdown, stripReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { scrubPaths } from './paths.js';
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
  // The live (non-Static) region must never grow taller than the viewport: Ink can't
  // erase a frame taller than the screen, which is what produces the "duplicated
  // terminal" on long streamed output and breaks native scrollback. Each active stream
  // block shows only its tail, sized so the blocks together fit the viewport. Full text
  // lands in <Static> when the message commits, where the terminal scrolls it natively.
  const active = [streamingReasoning, streaming.trim(), streamingTool].filter(Boolean).length || 1;
  const budget = liveTailBudget(active);

  return (
    <>
      <Static items={messages}>{(msg, i) => <MessageView key={i} msg={msg} />}</Static>
      {streamingReasoning ? (
        <Box marginTop={1}>
          <ReasoningBlock text={streamingReasoning} maxLines={budget} />
        </Box>
      ) : null}
      {streaming.trim() ? <StreamingContent text={streaming} maxLines={budget} /> : null}
      {streamingTool ? <StreamingTool text={streamingTool} maxLines={budget} /> : null}
    </>
  );
}

// Per-block budget for the live region, in *display* rows. Ink repaints the whole
// terminal — including `\x1b[3J`, which clears native scrollback (iTerm2's "a control
// sequence attempted to clear scrollback") — whenever the dynamic frame is at least
// as tall as the viewport (build/ink.js: `outputHeight >= stdout.rows`). So the
// active stream blocks plus the fixed chrome must stay strictly under it. Reserve
// chrome (input/status/working + the Box margins), a per-block overhead (each block's
// marginTop plus its header/"…" line), and one safety row, then split what's left.
function liveTailBudget(activeBlocks: number): number {
  const rows = process.stdout.rows || 24;
  const CHROME = 8;
  const PER_BLOCK_OVERHEAD = 3;
  const SAFETY = 2;
  const avail = rows - CHROME - SAFETY - activeBlocks * PER_BLOCK_OVERHEAD;
  return Math.max(3, Math.floor(avail / activeBlocks));
}

// Content width for a live block: terminal columns minus the App's paddingX={1} on
// each side. Matches the width Ink lays the block's <Text> out at.
function liveContentWidth(): number {
  return Math.max(20, (process.stdout.columns || 80) - 2);
}

// Bound text to its last `maxRows` *display* rows — the unit Ink measures when it
// decides the live frame exceeds the viewport. We wrap with the exact same wrap-ansi
// options Ink uses (build/wrap-text.js), so the row count matches and Ink's own
// re-wrap of the result is a no-op (lines are already ≤ width).
export function tailDisplay(
  text: string,
  maxRows: number,
  width: number,
): { text: string; truncated: boolean } {
  const rows = wrapAnsi(text, width, { trim: false, hard: true }).split('\n');
  if (rows.length <= maxRows) return { text: rows.join('\n'), truncated: false };
  return { text: rows.slice(-maxRows).join('\n'), truncated: true };
}

// Keep only the last `maxLines` newline-rows, with a character backstop for pathological
// long-unwrapped lines. `truncated` flags that earlier output was dropped from the view.
export function tailText(
  text: string,
  maxLines: number,
  maxChars = maxLines * 240,
): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out = lines.slice(-maxLines).join('\n');
    truncated = true;
  }
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    truncated = true;
  }
  return { text: out, truncated };
}

// Live assistant text: rendered as a bounded tail (markdown preview); the committed
// message re-renders the full text in <Static>.
function StreamingContent({ text, maxLines }: { text: string; maxLines: number }) {
  const width = liveContentWidth();
  // Cheap logical-line pre-trim caps markdown render cost on very long streams; the
  // factor keeps enough lines to fill `maxLines` display rows even when each wraps.
  // The render-then-tailDisplay below is what actually bounds the frame height — it
  // measures the *rendered* output (markdown can expand lines, e.g. code fences) in
  // wrapped display rows, which is what Ink counts against the viewport.
  const pre = tailText(text, maxLines * 4);
  const tail = tailDisplay(renderMarkdown(pre.text), maxLines, width);
  const truncated = pre.truncated || tail.truncated;
  return (
    <Box flexDirection="column" marginTop={1}>
      {truncated ? <Text color={theme.muted}>{'…'}</Text> : null}
      <Text>{tail.text}</Text>
    </Box>
  );
}

function StreamingTool({ text, maxLines }: { text: string; maxLines: number }) {
  const { text: shown, truncated } = tailDisplay(text, maxLines, liveContentWidth());
  return (
    <Box flexDirection="column" marginTop={1}>
      {truncated ? <Text color={theme.muted}>{'…'}</Text> : null}
      <Text color={theme.muted}>{scrubPaths(shown)}</Text>
    </Box>
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
        <Text>
          <Text color={theme.success}>{'$ '}</Text>
          <Text>{msg.command}</Text>
        </Text>
        {msg.output ? <Text color={theme.muted}>{msg.output}</Text> : null}
      </Box>
    );
  }
  if (msg.role === 'assistant') {
    // Models sometimes emit whitespace-only content alongside reasoning + a tool
    // call; rendering that as a real line would add a blank row (with margins on
    // both sides) between the Thinking block and the tool calls, so treat it as
    // empty.
    const hasContent = !!msg.content?.trim();
    return (
      <Box flexDirection="column" marginTop={1}>
        {msg.reasoning ? <ReasoningBlock text={msg.reasoning} /> : null}
        {hasContent ? (
          <Box marginTop={msg.reasoning ? 1 : 0}>
            <Text>{renderMarkdown(msg.content!)}</Text>
          </Box>
        ) : null}
        {msg.toolCalls && msg.toolCalls.length > 0 ? (
          // Gap above the tool calls only when reasoning/content sits above them
          // in this message; otherwise the message's own marginTop is the gap and
          // a second one would double up between back-to-back tool calls.
          <Box flexDirection="column" marginTop={msg.reasoning || hasContent ? 1 : 0}>
            {msg.toolCalls.map(tc => (
              // One Text with nested colored runs, not two sibling <Text> in a row:
              // when the line wraps (long edit args), Ink drops the boundary char
              // between adjacent siblings, rendering "• Edit(…)" as "• Edi(…)".
              <Text key={tc.id}>
                <Text color={theme.tool}>{`• ${capitalize(tc.name)}`}</Text>
                <Text color={theme.secondary}>{`(${formatArgs(tc.args)})`}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
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
        <Text>
          <Text color={theme.tool}>{'  ↳ '}</Text>
          <Text color={theme.secondary}>{scrubPaths(msg.summary ?? '')}</Text>
        </Text>
        {msg.diff ? (
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            <DiffView diff={msg.diff.text} path={msg.diff.path} maxWidth={diffViewWidth()} />
          </Box>
        ) : null}
        {msg.command ? (
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            <Text>
              <Text color={theme.success}>{'$ '}</Text>
              <Text>{scrubPaths(msg.command.text)}</Text>
            </Text>
            {msg.command.outputTail ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.muted}>{scrubPaths(msg.command.outputTail)}</Text>
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
    // Tone distinguishes harness notices: 'warn' (truncation retry) gets a recycle glyph in
    // warning yellow, 'info' (compaction) a caret in tool cyan, default a caret in accent.
    // Keeping the marker off the user's accent makes auto-events read as not-the-user.
    const markerColor =
      msg.tone === 'warn' ? theme.warning : msg.tone === 'info' ? theme.tool : theme.accent;
    const marker = msg.tone === 'warn' ? '⟳ ' : '❯ ';
    // Color must be on the OUTER Text so wrapped continuation lines inherit it;
    // a colored inner Text loses its color on wrap because Ink falls back to the
    // outer's color. The marker overrides for its own segment.
    return (
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={markerColor}>{marker}</Text>
          {msg.content}
        </Text>
      </Box>
    );
  }
  return null;
}

// Reasoning/"Thinking" preview: a muted bar down the left with a small label on
// top. Shares the user bubble's left-bar visual language but stays understated —
// muted bar, no background — so it reads as distinct from a user message.
function ReasoningBlock({ text, maxLines }: { text: string; maxLines?: number }) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2); // App applies paddingX={1} on each side.
  const contentW = Math.max(1, avail - 2); // '▎ ' gutter (2).
  // Models often emit leading/trailing newlines and blank-line runs; those would
  // become empty bar rows, so collapse blank lines and trim the ends first.
  const cleaned = stripReasoningMarkdown(text)
    .replace(/\n\s*\n/g, '\n')
    .trim();
  let lines = wrapText(cleaned, contentW);
  // Bound the live preview to its tail so the frame can't exceed the viewport; the
  // committed message passes no maxLines and shows in full (in <Static>).
  if (maxLines !== undefined && lines.length > maxLines) {
    lines = lines.slice(-maxLines);
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.muted}>{'▎ '}</Text>
        <Text bold color={theme.muted}>
          Thinking
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.muted}>{'▎ '}</Text>
          <Text color={theme.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

// Grey "bubble" for the user's message: an accent bar flush against the left
// edge (aligned with the Thinking block's bar), one space of padding after it
// and a trailing space, plus a blank background row above/below for breathing
// room.
function UserBubble({ text }: { text: string }) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2); // App applies paddingX={1} on each side.
  const contentW = Math.max(1, avail - 3); // '▎ ' gutter (2) + trailing space (1).
  const lines = wrapText(text, contentW);
  const rows = ['', ...lines, '']; // blank top/bottom rows = vertical padding.

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((line, i) => (
        <Text key={i} backgroundColor={theme.userBg}>
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
    .map(([k, v]) => `${k}=${truncate(scrubPaths(JSON.stringify(v)), 120)}`)
    .join(', ');
}

// Title-case the tool name's first letter for a tidier, conventional look
// (Read, List, Bash …).
function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
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
