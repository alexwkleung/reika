import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { ApprovalRequest } from '../types.js';
import { theme } from './theme.js';
import { DiffView } from './DiffView.js';
import { highlightCode } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';
import { contentWidth } from './layout.js';

// The dialog's own border (1 column each side) plus its paddingX={1}, on top of the App padding
// contentWidth already accounts for. The diff has to wrap inside all of it or its rows push
// through the border — which is also how the live frame ends up taller than Ink thinks it is.
const DIALOG_CHROME = 4;

// The chat's tool-call marker is `⏺︎`, which string-width scores as two columns while the
// terminal draws one. Unbordered that is invisible; inside a border Ink pads the row by its own
// count, so the right `│` lands a column early on that row (#450). `●` measures and draws one.
export const DIALOG_MARKER = '●';

// The dialog sits in Ink's live frame, and a frame as tall as the viewport makes Ink repaint the
// whole terminal with `\x1b[3J` — iTerm2's "attempted to clear scrollback" — and leaves the rows
// that scrolled off the top stranded in the scrollback after the dialog closes (#447). So the
// preview gets whatever the viewport has left. Fixed rows: marginTop, top border, both paddingY
// rows, the subject line, and the options and hint with their margins — then the input and status
// bar underneath, plus slack.
const DIALOG_FIXED_ROWS = 12;
const BELOW_DIALOG_ROWS = 6;
const MIN_PREVIEW_ROWS = 3;

export function approvalPreviewRows(
  warnings: number,
  reservedRows = 0,
  rows = process.stdout.rows || 24,
): number {
  const warningRows = warnings > 0 ? warnings + 1 : 0;
  return Math.max(
    MIN_PREVIEW_ROWS,
    rows - DIALOG_FIXED_ROWS - BELOW_DIALOG_ROWS - warningRows - reservedRows,
  );
}

export const APPROVAL_OPTIONS = ['Approve', 'Decline', 'Always (this session)'] as const;
export type ApprovalChoice = 0 | 1 | 2;

// The popup renders as the top half of one continuous frame whose bottom half is
// the input box (see Input's `attachedAbove`): `borderBottom={false}` + the input
// dropping its top border merges them into a single outline, so the prompt reads
// as part of the input region rather than a card floating above it. The frame
// stays neutral (no borderColor) to match the input; caution is signalled inside
// via themed `▲` warning lines, not a colored border.
export function Approval({
  request,
  selectedIndex,
  reservedRows = 0,
}: {
  request: ApprovalRequest;
  selectedIndex: number;
  // Other live rows above the dialog (plan checklist, queued messages) the preview must leave room for.
  reservedRows?: number;
}) {
  const isCommand = request.tool === 'bash';
  const warnings = request.warnings ?? [];
  const maxRows = approvalPreviewRows(warnings.length, reservedRows);
  return (
    <Box
      borderStyle="round"
      borderBottom={false}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      marginX={-1}
      marginTop={1}
    >
      {/* One Text with nested runs (not siblings): on wrap Ink drops the char at
          a sibling boundary, which would clip a long subject. Mirrors the chat's
          tool-call line — `● Bash` in tool grey, the subject receding in muted. */}
      <Text>
        <Text bold color={theme.tool}>{`${DIALOG_MARKER} ${capitalize(request.tool)}`}</Text>
        <Text color={theme.secondary}>{`  ${request.subject}`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {isCommand ? (
          <CommandPreview command={request.preview} maxRows={maxRows} />
        ) : (
          <DiffView
            diff={request.preview}
            path={request.subject}
            maxWidth={contentWidth(DIALOG_CHROME)}
            startLine={request.startLine}
            maxRows={maxRows}
            hiddenNote={n => `… ${n} more lines — the full diff prints once approved`}
          />
        )}
      </Box>
      {warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {warnings.map((w, i) => (
            <Text key={i} bold color={theme.warning}>{`▲ ${w}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((label, i) => {
          const selected = i === selectedIndex;
          return (
            <Text key={i}>
              <Text bold color={selected ? theme.accent : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text bold={selected} color={selected ? theme.accent : undefined}>
                {label}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {'↑↓ navigate  ·  enter select  ·  y/n shortcuts  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}

// The marker on a command's first row; every wrapped/extra line hangs under it by this width.
const MARKER = '$ ';
const MARKER_WIDTH = 2;

function CommandPreview({ command, maxRows }: { command: string; maxRows: number }) {
  // Sanitized like the scrollback chip (issue #154), but NOT scrubbed: this is the dialog where
  // the user decides whether to run the thing, so it must show the command as written, secrets
  // and all. Tabs and cursor motions still go — inside a bordered box they wrap past the border
  // and the frame comes apart around the very text being approved.
  const all = sanitizeTerminalText(command).split('\n');
  // Same width the rows are rendered at below, so the row counts fitted here are the row counts
  // the dialog actually draws.
  const width = Math.max(1, contentWidth(DIALOG_CHROME) - MARKER_WIDTH);
  const { lines, hidden } = fitCommandLines(all, maxRows, width);
  // Each logical line is pre-wrapped to the dialog width the way DiffView's WrappedRow does it
  // (#489): the `$`/`  ` marker and the text are adjacent siblings in a row Box, and when the row
  // is long enough to wrap, Ink drops the character at that sibling boundary — the space of `$ `,
  // which rendered every long approval as `$git checkout` with continuations back at column 0.
  // Wrapping ourselves keeps each row inside the width, so Ink never wraps one and the marker's
  // space survives; short commands were the only ones that kept their space before this.
  return (
    <>
      {lines.flatMap((line, i) => {
        const rows = wrapAnsi(highlightCode(line, 'bash'), width, {
          trim: false,
          hard: true,
        }).split('\n');
        return rows.map((row, j) => (
          <Box key={`${i}:${j}`}>
            <Text color={theme.success}>
              {j === 0 && i === 0 ? MARKER : ' '.repeat(MARKER_WIDTH)}
            </Text>
            <Text>{j === 0 ? row : dropWrapWhitespace(row)}</Text>
          </Box>
        ));
      })}
      {hidden > 0 ? <Text color={theme.muted}>{`… ${hidden} more lines`}</Text> : null}
    </>
  );
}

// trim:false leaves the space wrap-ansi broke on at the head of a continuation row, one column
// right of the hang — the same noise hangingWrap drops. Highlighting can open a color ahead of it.
function dropWrapWhitespace(row: string): string {
  return row.replace(/^((?:\x1b\[[0-9;]*m)*) +/, '$1');
}

// Leading lines that fit in `maxRows` wrapped rows, one reserved for the footer when any are cut.
export function fitCommandLines(
  lines: string[],
  maxRows: number,
  width: number,
): { lines: string[]; hidden: number } {
  const heights = lines.map(
    l => wrapAnsi(l, Math.max(1, width), { trim: false, hard: true }).split('\n').length,
  );
  if (heights.reduce((a, b) => a + b, 0) <= maxRows) return { lines, hidden: 0 };
  const budget = Math.max(1, maxRows - 1);
  let used = 0;
  let kept = 0;
  while (kept < lines.length && used + heights[kept] <= budget) used += heights[kept++];
  return { lines: lines.slice(0, kept), hidden: lines.length - kept };
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
