import type { ReactElement } from 'react';
import { useMemo, useRef } from 'react';
import { Box, Static, Text } from 'ink';
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { Message } from '../types.js';
import { hideDanglingMarkers, renderMarkdown, renderReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { scrubDisplay, scrubOutput } from './scrub.js';
import { DiffView } from './DiffView.js';
import { changeLabel, formatDurationMs, toolLabel, toolVerb } from './format.js';
import { contentWidth, hangingWrap } from './layout.js';

export function Scrollback({
  messages,
  streaming,
  streamingReasoning,
  streamingTool,
  streamingNested = false,
  streamingNote = false,
  streamingCommand = false,
  pendingTool = '',
  chromeRows = 0,
  showHeldWorked = true,
}: {
  messages: Message[];
  streaming: string;
  streamingReasoning: string;
  streamingTool: string;
  // The live blocks belong to a subagent running under the parent's tool call (#342). They render
  // at NESTED_INDENT so the streaming tail sits where its committed row will land a moment later,
  // instead of jumping left while live and right on commit.
  streamingNested?: boolean;
  // The stream is the compaction report round (#280): reasoning and note stream as one info-barred
  // block, the shape the committed note takes, so it reads as a harness aside rather than the reply.
  streamingNote?: boolean;
  // The live tail is a model-run `bash` command's output. That one commits inside the `$ command`
  // block MessageView draws at COMMAND_MARGIN (under the `↳ Ran: …` row), so it has to stream there
  // too or it sits 4 columns left of where it lands a moment later (#461). Anything else streaming
  // here stays at the left edge: shell mode's `shell` message prints its output flush left, and
  // `search`'s bot-check line commits as an ordinary notice, with no chip to sit under.
  streamingCommand?: boolean;
  // The model tool call running right now (#509), by name, or '' when none is. Drawn as a live
  // `↳ Running…` row in its result's place, so a call that stalls — a `bash` with output still to
  // come, an `edit`/`read`/`grep` that never streams at all — is visibly in flight instead of
  // leaving the committed call row above it looking like the app stopped.
  pendingTool?: string;
  // Extra fixed rows the App renders below the live region beyond the baseline CHROME (e.g. the
  // plan-progress checklist). Must be counted against the viewport budget or the live frame grows
  // past stdout.rows and Ink falls into its full-repaint path — visible as flicker at the bottom.
  chromeRows?: number;
  // Off while the spinner is up: the held "Worked for" line takes the spinner's rows, so the two
  // must swap in one frame for its height to stay put.
  showHeldWorked?: boolean;
}) {
  // The live (non-Static) region must never grow taller than the viewport: Ink can't
  // erase a frame taller than the screen, which is what produces the "duplicated
  // terminal" on long streamed output and breaks native scrollback. Each active stream
  // block shows only its tail, sized so the blocks together fit the viewport. Full text
  // lands in <Static> when the message commits, where the terminal scrolls it natively.
  const indent = streamingNested ? NESTED_INDENT : 0;
  const toolOffset = streamingCommand ? COMMAND_MARGIN : 0;
  const region = liveRegionRows(chromeRows);
  // Each block's fixed rows: its marginTop, plus the reasoning block's "Thinking" label.
  const blocks: { kind: 'reasoning' | 'content' | 'tool'; live: LiveRows; fixed: number }[] = [];
  if (streamingReasoning) {
    blocks.push({
      kind: 'reasoning',
      live: streamingReasoningRows(streamingReasoning, indent, region),
      fixed: 2,
    });
  }
  if (streaming.trim()) {
    const live = streamingNote
      ? streamingNoteRows(streaming, liveContentWidth(indent), region)
      : streamingContentRows(streaming, liveContentWidth(indent), region);
    // The note pays its label row and the bar row under it on top of the gap above it.
    blocks.push({ kind: 'content', live, fixed: streamingNote ? 3 : 1 });
  }
  if (streamingTool) {
    const live = streamingToolRows(streamingTool, liveContentWidth(indent + toolOffset), region);
    blocks.push({ kind: 'tool', live, fixed: 1 });
  }
  const pool = region - (pendingTool ? 1 : 0) - blocks.reduce((sum, b) => sum + b.fixed, 0);
  const shares = allocateLiveRows(
    blocks.map(b => (b.live.cut ? Infinity : b.live.rows.length)),
    pool,
  );
  const live = (
    <>
      {/* The call in flight (#509): the `↳` row its result will replace, drawn before the result
          exists. Same marker and colors as the committed row (MessageView), so the swap is a text-only
          change — nothing shifts when the tool returns. A `bash` tail streams under it at
          COMMAND_MARGIN, which is where that output commits too, so the block stays put as well. */}
      {pendingTool ? (
        <Text color={theme.secondary}>
          <Text color={theme.tool}>{TOOL_MARKER}</Text>
          {`${toolVerb(pendingTool)}…`}
        </Text>
      ) : null}
      {blocks.map((b, i) =>
        b.kind === 'reasoning' ? (
          <Box key={b.kind} marginTop={1}>
            <ReasoningBlock
              lines={b.live.rows.slice(-shares[i])}
              barColor={streamingNote ? theme.info : undefined}
            />
          </Box>
        ) : b.kind === 'content' && streamingNote ? (
          <NoteBody
            key={b.kind}
            tail={fitTail(b.live, shares[i])}
            joined={blocks[i - 1]?.kind === 'reasoning'}
          />
        ) : (
          <StreamingTail
            key={b.kind}
            tail={fitTail(b.live, shares[i])}
            muted={b.kind === 'tool'}
            // Relative to the live wrapper (which already pays `indent`), so a command's output
            // lands where the committed one will: inside the chip's margin, or flush left.
            offset={b.kind === 'tool' ? toolOffset : 0}
          />
        ),
      )}
    </>
  );

  const { log: scrollback, held } = useScrollbackLog(messages);
  return (
    <>
      <Static items={scrollback}>
        {(item, i) => <LogItemView key={i} item={item} prev={scrollback[i - 1]} />}
      </Static>
      {showHeldWorked && held !== null ? <WorkedRow durationMs={held} /> : null}
      {indent ? (
        // Same box MessageView gives a nested committed row: the margin plus an explicit width
        // that pays for it, so a full line wraps under Ink rather than at the terminal edge. Only
        // when nested — the top-level live region is left exactly as it was.
        <Box flexDirection="column" width={contentWidth(indent)} marginLeft={indent}>
          {live}
        </Box>
      ) : (
        live
      )}
    </>
  );
}

// What <Static> actually gets: the session's terminal scrollback, which only ever grows.
//
// `messages` is the ACTIVE conversation, and it is not append-only: a mode switch across the chat
// boundary swaps in the other side's stash, /new replaces it with a two-line receipt. <Static>
// can't follow that — it renders `items.slice(n)` where n is the length it saw last render, and
// the terminal keeps everything it already printed. So a swap that leaves the array no longer
// than before prints nothing (the "Agent mode." banner after a round trip through /chat, the /new
// receipt after any real conversation — #385), and one that leaves it longer reprints a slice of
// the restored stash that is already on screen.
//
// Append-only by identity instead: every message object is printed exactly once, the first time
// it appears, in the order it appeared. Restored messages were printed back when they were live;
// only the trailing echo + banner are new. Nothing in `messages` is ever edited in place after it
// commits (the live stream is separate state), so identity is the right key.
//
// A top-level turn's "Worked for" line is held out of the log until the next user message (a
// prompt or a command echo) and drawn live at idle instead, in the spinner's rows: committed with
// its message it lands while the spinner is still up, and the spinner leaving afterwards shrinks
// the frame and moves the input up. End-of-turn notices therefore print above it.
type LogItem = Message | { workedMs: number };

function useScrollbackLog(messages: Message[]): { log: LogItem[]; held: number | null } {
  const seen = useRef(new WeakSet<Message>());
  const log = useRef<LogItem[]>([]);
  const held = useRef<number | null>(null);
  return useMemo(() => {
    const fresh = messages.filter(m => !seen.current.has(m));
    if (fresh.length === 0) return { log: log.current, held: held.current };
    const next = [...log.current];
    for (const m of fresh) {
      seen.current.add(m);
      const endsTurn = m.role === 'assistant' && m.durationMs !== undefined && !m.nested;
      if (held.current !== null && (m.role === 'user' || endsTurn)) {
        next.push({ workedMs: held.current });
        held.current = null;
      }
      next.push(m);
      if (endsTurn) held.current = m.durationMs!;
    }
    log.current = next;
    return { log: next, held: held.current };
  }, [messages]);
}

// Rows the live region may use, in *display* rows. Ink repaints the whole terminal —
// including `\x1b[3J`, which clears native scrollback (iTerm2's "a control sequence
// attempted to clear scrollback") — whenever the dynamic frame is at least as tall as
// the viewport (build/ink.js: `outputHeight >= stdout.rows`). So the active stream
// blocks plus the fixed chrome must stay strictly under it: reserve the chrome
// (input/status/working + the Box margins) and a safety margin.
function liveRegionRows(extraChromeRows = 0): number {
  const rows = process.stdout.rows || 24;
  const CHROME = 8;
  const SAFETY = 2;
  return rows - CHROME - extraChromeRows - SAFETY;
}

const MIN_BLOCK_ROWS = 3;

// Splits `pool` rows between the live blocks, given in display order, so the newest block (last)
// grows first and the older ones give up a row for each row it gains. An even split shrank a long
// reasoning tail to half the moment the answer began, so the frame dropped and the input jumped up
// mid-turn; this way the region's height only grows until it reaches the pool, then holds.
export function allocateLiveRows(needs: number[], pool: number): number[] {
  const out = needs.map(() => 0);
  let left = pool;
  for (let i = needs.length - 1; i >= 0; i--) {
    out[i] = Math.min(needs[i], Math.max(MIN_BLOCK_ROWS, left - MIN_BLOCK_ROWS * i));
    left -= out[i];
  }
  return out;
}

// Content width for a live block. Matches the width Ink lays the block's <Text> out at.
function liveContentWidth(indent = 0): number {
  return contentWidth(indent);
}

// Display rows of already-rendered text — the unit Ink measures when it decides the live frame
// exceeds the viewport. Wrapped with the exact wrap-ansi options Ink uses (build/wrap-text.js), so
// the count matches and Ink's own re-wrap of a row is a no-op (rows are already ≤ width).
export function displayRows(text: string, width: number): string[] {
  return wrapAnsi(text, width, { trim: false, hard: true }).split('\n');
}

// A live block's rows before they are fitted to its share of the region. `cut` means the cheap
// pre-trim already dropped earlier output, so the block needs more rows than it will ever get.
type LiveRows = { rows: string[]; cut: boolean };

// The block's last rows that fit `allowance`, the "…" marker counted inside it.
export function fitTail(block: LiveRows, allowance: number): { text: string; marker: boolean } {
  if (!block.cut && block.rows.length <= allowance) {
    return { text: block.rows.join('\n'), marker: false };
  }
  return { text: block.rows.slice(-Math.max(1, allowance - 1)).join('\n'), marker: true };
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
// message re-renders the full text in <Static>. The logical-line pre-trim caps markdown render cost
// on very long streams; the factor keeps enough lines to fill `bound` display rows even when each
// wraps. The rows are measured *rendered* (markdown can expand lines, e.g. code fences), which is
// what Ink counts against the viewport.
function streamingContentRows(text: string, width: number, bound: number): LiveRows {
  const pre = tailText(text, bound * 4);
  // A pre-trimmed tail starts mid-message, so its first row gets the indent, not the marker.
  const prose = markProse(
    renderMarkdown(hideDanglingMarkers(pre.text), width - CALL_MARKER_MEASURED),
    !pre.truncated,
  );
  return { rows: displayRows(prose, width), cut: pre.truncated };
}

// The live tail of a compaction note: its rows sit behind the bar, so no prose marker and two
// columns narrower. Same pre-trim and measuring as streamingContentRows.
function streamingNoteRows(text: string, width: number, bound: number): LiveRows {
  const pre = tailText(text, bound * 4);
  return { rows: noteBodyRows(hideDanglingMarkers(pre.text), width), cut: pre.truncated };
}

function noteBodyRows(text: string, width: number): string[] {
  const inner = width - NOTE_BAR.length;
  return displayRows(renderMarkdown(text, inner), inner);
}

// The live tail of a running command. The App accumulates the run's whole output, and scrubbing
// plus wrapping all of it on every 50ms flush is the cost the pre-trim avoids. trimEnd matches the
// committed chip, which drops the trailing newline — left in, the live tail grows a blank row that
// vanishes on commit. Scrubbed first, as the committed chip is: `sanitizeTerminalText` resolves
// carriage returns and flattens control codes, so wrapping the raw stream would break its rows
// somewhere else. `hangingWrap(…, 0)` is the committed chip's own wrap of raw output — the same
// wrap-ansi options, so the row count is unchanged — and it drops the whitespace a break happened
// on, putting a continuation row at the block's left edge instead of staggered right of it (#461).
function streamingToolRows(text: string, width: number, bound: number): LiveRows {
  const pre = tailText(text.trimEnd(), bound * 4);
  return {
    rows: displayRows(hangingWrap(scrubOutput(pre.text), width, 0), width),
    cut: pre.truncated,
  };
}

// `offset` is how far inside the live wrapper the committed row will sit (the command chip's
// margin), so the tail doesn't jump sideways when it commits (#461).
function StreamingTail({
  tail,
  muted = false,
  offset = 0,
}: {
  tail: { text: string; marker: boolean };
  muted?: boolean;
  offset?: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={offset}>
      {tail.marker ? <Text color={theme.muted}>{'…'}</Text> : null}
      <Text color={muted ? theme.muted : undefined}>{tail.text}</Text>
    </Box>
  );
}

// A compaction note is one block behind a single info bar: its Thinking, then the note under a
// label (#498). It sits at the left edge — a nested indent read as a subagent with no chip above
// it — and wears no prose marker, which would make it read as the model's reply to the user.
const NOTE_BAR = '▎ ';
const NOTE_LABEL = 'Compaction note';

function NoteBarRow({ children }: { children?: ReactElement | string }) {
  return (
    <Box>
      <Text color={theme.info}>{NOTE_BAR}</Text>
      {typeof children === 'string' ? <Text>{children}</Text> : (children ?? null)}
    </Box>
  );
}

// `joined`: a Thinking block sits directly above, so the gap between them is a bar row that keeps
// the bar unbroken; alone, the block takes an ordinary margin.
function NoteBody({ tail, joined }: { tail: { text: string; marker: boolean }; joined: boolean }) {
  return (
    <Box flexDirection="column" marginTop={joined ? 0 : 1}>
      {joined ? <NoteBarRow /> : null}
      <NoteBarRow>
        {/* Louder than Thinking on purpose: this is the part that survives the fold. */}
        <Text color={theme.info} bold>
          {NOTE_LABEL}
        </Text>
      </NoteBarRow>
      {/* Unlike Thinking's muted body, the note's is ordinary text that often opens on a bold
          heading; without a gap the label reads as the note's own first line. */}
      <NoteBarRow />
      {tail.marker ? (
        <NoteBarRow>
          <Text color={theme.muted}>{'…'}</Text>
        </NoteBarRow>
      ) : null}
      {tail.text.split('\n').map((row, i) => (
        <NoteBarRow key={i}>{row}</NoteBarRow>
      ))}
    </Box>
  );
}

function CompactionNoteBlock({
  note,
  reasoning,
  indent,
}: {
  note: string;
  reasoning?: string;
  indent: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {reasoning ? (
        <ReasoningBlock lines={reasoningLines(reasoning, indent)} barColor={theme.info} />
      ) : null}
      <NoteBody
        tail={{ text: noteBodyRows(note, contentWidth(indent)).join('\n'), marker: false }}
        joined={!!reasoning}
      />
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
// U+23FA (the record glyph) with U+FE0E, Variation Selector-15: the selector pins text
// presentation, so a terminal that would otherwise pull the emoji font and draw a colored,
// double-width disc draws the monochrome one-column glyph instead. Bigger than `•` (which
// reads as a list bullet) and, unlike `⏺︎`, centered on the lowercase rather than the cap height.
//
// The terminal draws it in ONE column, but string-width (what Ink measures with) scores it as
// two — so this marker has two widths, and they are used for different things:
//   CALL_MARKER_WIDTH  — the columns the terminal draws: the hanging indent of continuation rows.
//   CALL_MARKER_MEASURED — the columns Ink thinks the first row spends: its wrap budget. Budgeting
//   with the larger number keeps Ink from re-wrapping a row that fills the width; the first row
//   comes out one column short of what the terminal could fit, which is invisible.
const CALL_MARKER = '\u23FA\uFE0E ';
const CALL_MARKER_WIDTH = 2;
const CALL_MARKER_MEASURED = stringWidth(CALL_MARKER);
const NOTICE_MARKER_WIDTH = 2; // '❯ ' / '⟳ '

// Assistant prose wears the tool-call glyph so a turn reads as one sequence of steps (#497), in
// theme.secondary against a call's theme.tool: one shape told apart by brightness, the way `▎` is
// by hue. Rendered markdown is budgeted CALL_MARKER_MEASURED narrower and every row hangs under
// the marker's drawn width. A string, not nested <Text>: the live tail slices it by rows.
export function markProse(rendered: string, withMarker = true): string {
  const pad = ' '.repeat(CALL_MARKER_WIDTH);
  return rendered
    .split('\n')
    .map((line, i) => {
      if (i === 0 && withMarker) return chalk.hex(theme.secondary)(CALL_MARKER) + line;
      return line ? pad + line : line;
    })
    .join('\n');
}
// marginLeft on a tool result's command/output block; it pays for that out of the row's width.
const COMMAND_MARGIN = 4;

function WorkedRow({ durationMs }: { durationMs: number }) {
  return (
    <Box marginTop={1}>
      {/* Filled square doubles as a "turn complete" marker (the universal
          stop/done glyph) and an anchor of color on an otherwise inert line. */}
      <Text>
        <Text color={theme.accent}>{'■ '}</Text>
        <Text color={theme.muted}>{`Worked for ${formatDurationMs(durationMs)}`}</Text>
      </Text>
    </Box>
  );
}

function LogItemView({ item, prev }: { item: LogItem; prev?: LogItem }) {
  if ('workedMs' in item) return <WorkedRow durationMs={item.workedMs} />;
  return <MessageView msg={item} prev={prev && 'workedMs' in prev ? undefined : prev} />;
}

function MessageView({ msg, prev }: { msg: Message; prev?: Message }) {
  const nested = 'nested' in msg && !!msg.nested;
  const indent = nested ? NESTED_INDENT : 0;
  // A top-level row that follows a nested one closes out a subagent block. Tool rows
  // are the only role with no marginTop of their own (they sit tight under the tool
  // call that produced them), so without this the subagent's closing "Worked for …"
  // and the parent's "↳ Subagent completed (…)" collide on adjacent lines.
  const afterNested = !nested && !!prev && 'nested' in prev && !!prev.nested;
  // The notice that immediately precedes a tool row (e.g. the once-per-cwd sandbox line the first
  // bash call of a session commits mid-turn, #485) has spacing above but none below: the tool row
  // normally sits tight under the call that produced it, so a notice following one runs straight
  // into the next tool row. The gap belongs before the tool row, where the margin field is.
  const afterNotice = !!prev && prev.role === 'system';
  // Back-to-back tool rows sit tight, but once either one carries a block (a diff, a command
  // chip, a bash change list) the next `↳` reads as another line of that block's output rather
  // than a result of its own (#492). Summary-only rows (reads, greps) stay tight among themselves.
  const afterToolBlock =
    msg.role === 'tool' &&
    prev?.role === 'tool' &&
    (hasBlockUnderSummary(prev) || hasBlockUnderSummary(msg));
  const inner = renderMessage(msg, indent, { nested, afterNested, afterNotice, afterToolBlock });
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

function hasBlockUnderSummary(msg: Message): boolean {
  return msg.role === 'tool' && !!(msg.diff || msg.command || msg.changes);
}

function renderMessage(
  msg: Message,
  indent = 0,
  ctx: {
    nested?: boolean;
    afterNested?: boolean;
    afterNotice?: boolean;
    afterToolBlock?: boolean;
  } = {},
): ReactElement | null {
  if (msg.role === 'user') {
    return <UserBubble text={msg.display ?? msg.content} indent={indent} nested={ctx.nested} />;
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
        {/* Trimmed like the bash chip's tail: a trailing newline drew a stray blank row above
            the next block's margin. */}
        {msg.output.trimEnd() ? (
          <Text color={theme.muted}>
            {hangingWrap(scrubOutput(msg.output.trimEnd()), contentWidth(indent), 0)}
          </Text>
        ) : null}
      </Box>
    );
  }
  if (msg.role === 'assistant' && msg.compactionNote) {
    return (
      <CompactionNoteBlock note={msg.content ?? ''} reasoning={msg.reasoning} indent={indent} />
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
        {msg.reasoning ? <ReasoningBlock lines={reasoningLines(msg.reasoning, indent)} /> : null}
        {hasContent ? (
          <Box marginTop={msg.reasoning ? 1 : 0}>
            <Text>
              {markProse(renderMarkdown(msg.content!, contentWidth(indent) - CALL_MARKER_MEASURED))}
            </Text>
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
              // between adjacent siblings, rendering "⏺︎ Edit(…)" as "⏺︎ Edi(…)".
              <Text key={tc.id}>
                <Text color={theme.tool}>{`${CALL_MARKER}${toolLabel(tc.name)}`}</Text>
                <Text color={theme.secondary}>
                  {hangingWrap(
                    `(${formatArgs(tc.name, tc.args)})`,
                    contentWidth(indent),
                    CALL_MARKER_WIDTH,
                    // The name sits between the marker and the args, so the first row has less
                    // room than the rest — but the indent stays the marker's drawn width.
                    CALL_MARKER_MEASURED + toolLabel(tc.name).length,
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
        {/* A top-level turn's line is its own log entry (useScrollbackLog); only a subagent's
            stays inline, since it closes a nested block mid-turn. */}
        {msg.durationMs !== undefined && ctx.nested ? (
          <WorkedRow durationMs={msg.durationMs} />
        ) : null}
      </Box>
    );
  }
  if (msg.role === 'tool') {
    return (
      <Box
        flexDirection="column"
        marginTop={ctx.afterNested || ctx.afterNotice || ctx.afterToolBlock ? 1 : 0}
      >
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
        {msg.changes ? (
          // Files a bash command changed, drawn like an edit's diff and indented the same, so a
          // `sed -i` and an edit-tool change read identically under their chips (#278).
          <Box flexDirection="column" marginTop={1} marginLeft={4}>
            {msg.changes.files.map((f, fi) => (
              <Box key={f.path} flexDirection="column" marginTop={fi > 0 ? 1 : 0}>
                <Text>
                  <Text color={theme.tool}>{scrubDisplay(f.path)}</Text>
                  <Text color={theme.muted}>{` ${changeLabel(f)}`}</Text>
                </Text>
                {f.hunks.map((h, hi) => (
                  <Box key={hi} flexDirection="column" marginTop={hi > 0 ? 1 : 0}>
                    <DiffView
                      diff={h.text}
                      path={f.path}
                      maxWidth={diffViewWidth(indent)}
                      startLine={h.startLine}
                      oldStartLine={h.oldStartLine}
                    />
                  </Box>
                ))}
                {f.omitted ? <Text color={theme.muted}>{`…(${f.omitted} more lines)`}</Text> : null}
              </Box>
            ))}
            {msg.changes.more > 0 ? (
              <Text color={theme.muted}>{`…${msg.changes.more} more files changed`}</Text>
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
        <Text color={theme.error}>Error</Text>
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
function reasoningLines(text: string, indent: number): string[] {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2 - indent); // App applies paddingX={1} on each side.
  const contentW = Math.max(1, avail - 2); // '▎ ' gutter (2).
  // Models often emit leading/trailing newlines and blank-line runs; those would
  // become empty bar rows, so collapse blank lines and trim the ends first.
  const cleaned = renderReasoningMarkdown(text, contentW)
    .replace(/\n\s*\n/g, '\n')
    .replace(/^\s*\n|\s+$/g, '');
  return displayRows(cleaned, contentW);
}

// The live Thinking tail. Pre-trimmed like the reply's stream, since every flush re-parses it; the
// committed block renders the whole text.
function streamingReasoningRows(text: string, indent: number, bound: number): LiveRows {
  const pre = tailText(text, bound * 4);
  return { rows: reasoningLines(hideDanglingMarkers(pre.text), indent), cut: pre.truncated };
}

// `lines` arrives already bounded: the live region passes its tail, a committed message all of it.
function ReasoningBlock({
  lines,
  barColor = theme.reasoning,
}: {
  lines: string[];
  barColor?: string;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={barColor}>{'▎ '}</Text>
        {/* The bar's color, not the body's muted gray: in the same color the label read as the
            thought's first line and the block's top edge blurred into the reply beneath it. */}
        <Text color={barColor} bold>
          Thinking
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={barColor}>{'▎ '}</Text>
          <Text color={theme.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

// Grey "bubble" for the user's message: an accent bar flush against the left
// edge (aligned with the Thinking block's bar), one space of padding after it
// and a trailing space. No blank rows inside the background: the bubble sits
// as tight as the Thinking block so the two read as one visual language.
function UserBubble({
  text,
  indent = 0,
  nested = false,
}: {
  text: string;
  indent?: number;
  nested?: boolean;
}) {
  const term = process.stdout.columns || 80;
  const avail = Math.max(20, term - 2 - indent); // App applies paddingX={1} on each side.
  const contentW = Math.max(1, avail - 3); // '▎ ' gutter (2) + trailing space (1).
  // scrubOutput, not scrubDisplay: this was the one render site running neither scrubber, so a
  // subagent's task ("Read /Users/…/web/src/x.ts …") printed the absolute path in full while the
  // Subagent(task=…) call above it — which goes through formatArgs — showed it collapsed (#172).
  // The sanitize layer matters here too: rows are padEnd-ed to a fixed width against the grey
  // background, so a tab or escape sequence in a paste would mis-measure and fracture the bubble.
  const rows = wrapText(scrubOutput(text), contentW);
  // The accent bar means "the user said this". A nested bubble is the parent agent's task text,
  // not the user's, so it takes its own color — see theme.subagent for why it is not `queued`.
  const barColor = nested ? theme.subagent : theme.accent;

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((line, i) => (
        <Text key={i} backgroundColor={theme.userBg}>
          <Text color={barColor}>▎</Text>
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
// bloat the header — drop them so e.g. an edit reads "⏺︎ Edit(path=…)" instead of
// "⏺︎ Edit(path=…, old_string=…, new_string=…)". Path stays; it's the one bit the
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
