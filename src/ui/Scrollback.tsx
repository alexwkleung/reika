import type { ReactElement } from 'react';
import { Box, Static, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { Message } from '../types.js';
import { renderMarkdown, stripReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { scrubDisplay, scrubOutput } from './scrub.js';
import { DiffView } from './DiffView.js';
import { Header } from './Header.js';
import { formatDurationMs } from './format.js';
import { contentWidth, hangingWrap } from './layout.js';

export function Scrollback({
  messages,
  streaming,
  streamingReasoning,
  streamingTool,
  chromeRows = 0,
}: {
  messages: Message[];
  streaming: string;
  streamingReasoning: string;
  streamingTool: string;
  // Extra fixed rows the App renders below the live region beyond the baseline CHROME (e.g. the
  // plan-progress checklist). Must be counted against the viewport budget or the live frame grows
  // past stdout.rows and Ink falls into its full-repaint path — visible as flicker at the bottom.
  chromeRows?: number;
}) {
  // The live (non-Static) region must never grow taller than the viewport: Ink can't
  // erase a frame taller than the screen, which is what produces the "duplicated
  // terminal" on long streamed output and breaks native scrollback. Each active stream
  // block shows only its tail, sized so the blocks together fit the viewport. Full text
  // lands in <Static> when the message commits, where the terminal scrolls it natively.
  const active = [streamingReasoning, streaming.trim(), streamingTool].filter(Boolean).length || 1;
  const budget = liveTailBudget(active, chromeRows);

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
function liveTailBudget(activeBlocks: number, extraChromeRows = 0): number {
  const rows = process.stdout.rows || 24;
  const CHROME = 8;
  const PER_BLOCK_OVERHEAD = 3;
  const SAFETY = 2;
  const avail = rows - CHROME - extraChromeRows - SAFETY - activeBlocks * PER_BLOCK_OVERHEAD;
  return Math.max(3, Math.floor(avail / activeBlocks));
}

// Content width for a live block. Matches the width Ink lays the block's <Text> out at.
function liveContentWidth(): number {
  return contentWidth();
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
      <Text color={theme.muted}>{scrubOutput(shown)}</Text>
    </Box>
  );
}

// Subagent messages render indented under the parent turn. Blocks that size
// themselves off process.stdout.columns (the user bubble's padded background
// rows, the reasoning bar, the diff view) must subtract that indent too —
// otherwise each row is laid out 4 columns wider than its box and Ink wraps the
// overflow onto a stray continuation row, breaking the bubble's background into
// fragments with no bar.
const NESTED_INDENT = 4;

// Line markers, and the hanging indent each one buys: a wrapped row lands under the text the
// marker introduces, not under the marker and not at column 0. Kept as constants because the
// indent must be the marker's exact rendered width — `↳` measures 1 column, so '  ↳ ' is 4.
const TOOL_MARKER = '  ↳ ';
const SHELL_MARKER = '$ ';
const CALL_MARKER = '• ';
const NOTICE_MARKER_WIDTH = 2; // '❯ ' / '⟳ '
// marginLeft on a tool result's command/output block; it pays for that out of the row's width.
const COMMAND_MARGIN = 4;

function MessageView({ msg }: { msg: Message }) {
  const nested = 'nested' in msg && !!msg.nested;
  const indent = nested ? NESTED_INDENT : 0;
  const inner = renderMessage(msg, indent);
  if (inner === null) return null;
  // Explicit width, on every scrollback row: <Static> is laid out in its own pass that does NOT
  // inherit the App's paddingX={1}, so a plain <Text> here wraps at the FULL terminal width and is
  // then painted one column in — every row that fills the line overflows by exactly one column and
  // the terminal wraps that one character down to column 0 on its own (the stray `=`/`n`/`|` in
  // issue #167). Blocks that size themselves off process.stdout.columns (the bubble, the reasoning
  // bar, the diff view) already pay for the padding; this covers the ones that let Ink wrap.
  return (
    <Box flexDirection="column" width={contentWidth(indent)} marginLeft={indent}>
      {inner}
    </Box>
  );
}

function renderMessage(msg: Message, indent = 0): ReactElement | null {
  if (msg.role === 'user') {
    return <UserBubble text={msg.display ?? msg.content} indent={indent} />;
  }
  if (msg.role === 'header') {
    return <Header model={msg.model} cwd={msg.cwd} />;
  }
  if (msg.role === 'shell') {
    // Scrubbed exactly like the bash tool's command/outputTail above. Shell mode runs the same
    // commands through the same terminal — the only difference is that no model sees them — so
    // `security find-identity` in /shell must not render an identity the bash tool would redact.
    // The transcript already redacts shell messages on save; this brings the UI in line with it.
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={theme.success}>{SHELL_MARKER}</Text>
          <Text>
            {hangingWrap(scrubOutput(msg.command), contentWidth(indent), SHELL_MARKER.length)}
          </Text>
        </Text>
        {msg.output ? (
          <Text color={theme.muted}>
            {hangingWrap(scrubOutput(msg.output), contentWidth(indent), 0)}
          </Text>
        ) : null}
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
        {msg.reasoning ? <ReasoningBlock text={msg.reasoning} indent={indent} /> : null}
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
                <Text color={theme.tool}>{`${CALL_MARKER}${capitalize(tc.name)}`}</Text>
                <Text color={theme.secondary}>
                  {hangingWrap(
                    `(${formatArgs(tc.name, tc.args)})`,
                    contentWidth(indent),
                    CALL_MARKER.length,
                    // The name sits between the marker and the args, so the first row has less
                    // room than the rest — but the indent stays the marker's width.
                    CALL_MARKER.length + capitalize(tc.name).length,
                  )}
                </Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {msg.sources && msg.sources.length > 0 ? (
          <Box marginTop={1}>
            {/* Fetched URLs are usually public, but this was the one render site running
                neither scrubber — and a `file://` source or a self-hosted URL carrying the
                account slug leaks the same way any other line would. */}
            <Text color={theme.tool}>{scrubDisplay(`Sources: ${msg.sources.join(', ')}`)}</Text>
          </Box>
        ) : null}
        {msg.durationMs !== undefined ? (
          <Box marginTop={1}>
            {/* Filled square doubles as a "turn complete" marker (the universal
                stop/done glyph) and an anchor of color on an otherwise inert line. */}
            <Text>
              <Text color={theme.accent}>{'■ '}</Text>
              <Text color={theme.muted}>{`Worked for ${formatDurationMs(msg.durationMs)}`}</Text>
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (msg.role === 'tool') {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.tool}>{TOOL_MARKER}</Text>
          {/* Drop the redundant leading "Read " for display only: the `↳` already
              marks this as a child of the Read tool call, and the path follows
              immediately so it reads cleanly. The model-facing summary
              (loop.ts) keeps the verb as grounding. Scoped to Read because other
              tools' verbs ("Found", "Ran:", "Edited") carry meaning. */}
          {/* scrubOutput, not scrubDisplay: a summary quotes what the tool was given — a bash
              command, an edit's non-matching line — so it can carry the same tabs and control
              characters raw output does, on a row that must stay one row. */}
          <Text color={theme.secondary}>
            {hangingWrap(
              scrubOutput((msg.summary ?? '').replace(/^Read /, '')),
              contentWidth(indent),
              TOOL_MARKER.length,
            )}
          </Text>
        </Text>
        {msg.diff ? (
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            <DiffView
              diff={msg.diff.text}
              path={msg.diff.path}
              maxWidth={diffViewWidth(indent)}
              startLine={msg.diff.startLine}
            />
          </Box>
        ) : null}
        {msg.command ? (
          <Box flexDirection="column" marginTop={1} marginLeft={COMMAND_MARGIN}>
            <Text>
              <Text color={theme.success}>{SHELL_MARKER}</Text>
              <Text>
                {hangingWrap(
                  scrubOutput(msg.command.text),
                  contentWidth(COMMAND_MARGIN + indent),
                  SHELL_MARKER.length,
                )}
              </Text>
            </Text>
            {msg.command.outputTail ? (
              <Box flexDirection="column" marginTop={1}>
                {/* Above the lines, not below: these are the LAST lines of the run, so whatever
                    was dropped came before them. The marker used to sit underneath, which read
                    correctly when the chip showed the head and would now be backwards. */}
                {msg.command.outputTruncated ? (
                  <Text color={theme.muted}>…(earlier output omitted)</Text>
                ) : null}
                {/* hang 0: raw output has no marker to hang under, but it still goes through
                    the same wrap so a break inside expanded tabs can't stagger the rows right of
                    the chip's indent. */}
                <Text color={theme.muted}>
                  {hangingWrap(
                    scrubOutput(msg.command.outputTail),
                    contentWidth(COMMAND_MARGIN + indent),
                    0,
                  )}
                </Text>
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
        {/* Scrubbed like the notices below: errors quote paths from whatever threw
            (fs errno strings, save/paste failures), and an error box is the text
            most likely to be screenshotted or pasted into a bug report. `~/…`
            costs nothing diagnostically — only the prefix is rewritten. */}
        <Text>{scrubDisplay(msg.content)}</Text>
      </Box>
    );
  }
  if (msg.role === 'system') {
    // Tone distinguishes harness notices: 'warn' (truncation retry) gets a recycle glyph in
    // warning yellow, 'info' (compaction) a caret in info cyan, default a caret in accent.
    // Keeping the marker off the user's accent makes auto-events read as not-the-user.
    const markerColor =
      msg.tone === 'warn' ? theme.warning : msg.tone === 'info' ? theme.info : theme.accent;
    const marker = msg.tone === 'warn' ? '⟳ ' : '❯ ';
    // Color must be on the OUTER Text so wrapped continuation lines inherit it;
    // a colored inner Text loses its color on wrap because Ink falls back to the
    // outer's color. The marker overrides for its own segment.
    return (
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={markerColor}>{marker}</Text>
          {/* Harness notices quote absolute paths (/save's history files, /cd's target).
              Scrub them the same way tool lines are scrubbed so the home prefix doesn't
              leak into scrollback (and screenshots) — display only; the files are still
              written to, and the model still sees, the absolute path. */}
          {hangingWrap(scrubDisplay(msg.content), contentWidth(indent), NOTICE_MARKER_WIDTH)}
        </Text>
      </Box>
    );
  }
  return null;
}

// Reasoning/"Thinking" preview: a cornflower-blue bar down the left with a small
// label on top. Shares the user bubble's left-bar visual language but stays
// understated — colored bar, muted text, no background, and dimmer than the
// user bar's accent — so it reads as a subordinate aside, not a user message.
function ReasoningBlock({
  text,
  maxLines,
  indent = 0,
}: {
  text: string;
  maxLines?: number;
  indent?: number;
}) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2 - indent); // App applies paddingX={1} on each side.
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
        <Text color={theme.reasoning}>{'▎ '}</Text>
        <Text bold color={theme.muted}>
          Thinking
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.reasoning}>{'▎ '}</Text>
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
function UserBubble({ text, indent = 0 }: { text: string; indent?: number }) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2 - indent); // App applies paddingX={1} on each side.
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
          <Text color="whiteBright">{` ${line.padEnd(contentW)} `}</Text>
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

// Args whose values are already shown in full elsewhere (the diff view) and only
// bloat the header — drop them so e.g. an edit reads "• Edit(path=…)" instead of
// "• Edit(path=…, old_string=…, new_string=…)". Path stays; it's the one bit the
// diff header doesn't make obvious at a glance.
const HIDDEN_ARGS: Record<string, ReadonlySet<string>> = {
  edit: new Set(['old_string', 'new_string']),
  write: new Set(['content']),
};

function formatArgs(name: string, args: Record<string, unknown>): string {
  const hidden = HIDDEN_ARGS[name];
  return Object.entries(args)
    .filter(([k]) => !hidden?.has(k))
    .map(([k, v]) => `${k}=${truncate(scrubDisplay(JSON.stringify(v)), 120)}`)
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
// paddingX={1} on each side (2) plus the tool-diff marginLeft={4} = 6, and the
// nesting indent when the tool ran inside a subagent.
function diffViewWidth(indent = 0): number {
  // DIFF_MARGIN is the diff block's own marginLeft={4}; contentWidth pays for the App's paddingX.
  return contentWidth(DIFF_MARGIN + indent);
}

const DIFF_MARGIN = 4;
