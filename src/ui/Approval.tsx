import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { ApprovalRequest } from '../types.js';
import { APPROVAL_OPTIONS } from './dialogspecs.js';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';
import { DiffView } from './DiffView.js';
import { highlightCode } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';
import {
  hangingRows,
  hangingWrap,
  useContentWidth,
  wrappedRows,
  wrapStyledRows,
} from './layout.js';
import { toolLabel } from './format.js';

// The dialog's own border (1 column each side) plus its paddingX={1}, on top of the App padding
// contentWidth already accounts for. The diff has to wrap inside all of it or its rows push
// through the border — which is also how the live frame ends up taller than Ink thinks it is.
const DIALOG_CHROME = 4;

// The chat's tool-call marker, bare: with its VS15 Ink spends a grid cell the terminal never
// draws and the right `│` lands a column early (#450). The selector is restored at the stream
// (`restoreTextPresentation`, syncframe.ts), after Ink has laid the row out (#494).
export const DIALOG_MARKER = glyphs.dialogCall;

// The dialog sits in Ink's live frame, and a frame as tall as the viewport makes Ink repaint the
// whole terminal with `\x1b[3J` — iTerm2's "attempted to clear scrollback" — and leaves the rows
// that scrolled off the top stranded in the scrollback after the dialog closes (#447). So the
// preview gets whatever the viewport has left: the frame, the subject, the warnings, the options
// and the hint are paid for first, and the input and status bar underneath get their reserve.
//
// Those chrome rows are MEASURED, not assumed (#842). On a narrow pane the subject, each warning,
// the option labels and the hint all wrap, and a constant that counted one row each undercounted
// the frame by the wraps — so the preview sized itself against a budget the dialog then overspent,
// and on a small pane the frame reached the viewport height and cleared the scrollback.
const FRAME_ROWS = 4; // marginTop, top border, and both paddingY rows
const GAP_ROWS = 1; // the margin above the preview, the warnings, the options and the hint
const OPTION_HANG = 2; // '› ' — the marker every option row hangs under
const BELOW_DIALOG_ROWS = 6; // the input box, the status bar, and slack
const MIN_PREVIEW_ROWS = 3;

export const APPROVAL_HINT = '↑↓ navigate  ·  enter select  ·  y/n shortcuts  ·  ctrl-c abort';
export const APPROVAL_TYPING_HINT = 'enter send  ·  ctrl-c back to the options';
const APPROVAL_TYPING_LINE = 'Declining — type what to do instead below';

// What the dialog costs vertically at `cols` columns and how much of `rows` the preview may take.
// `height` is what the dialog draws, so `height + BELOW_DIALOG_ROWS <= rows - 1` holds wherever the
// pane has room for the dialog at all.
//
// The budget is `rows - 1`: Ink's condition is `outputHeight >= stdout.rows` (build/ink.js), so a
// frame that lands exactly on the viewport height is already a full repaint. When the measured
// chrome leaves the preview under `MIN_PREVIEW_ROWS`, the HINT is what goes — the options and the
// warnings are what the user is deciding on, and the preview is where the evidence is.
const withGap = (rows: number): number => rows + GAP_ROWS;

export function layoutApproval(
  request: ApprovalRequest,
  typing: boolean,
  cols: number,
  rows = process.stdout.rows || 24,
  reservedRows = 0,
): { previewRows: number; showHint: boolean; hint: string; height: number } {
  const warnings = request.warnings ?? [];
  // Pre-wrapped, so the rows counted here are the rows drawn whatever width Ink lays the frame
  // out in, rather than only the width this measured at.
  const hint = hangingWrap(typing ? APPROVAL_TYPING_HINT : APPROVAL_HINT, Math.max(1, cols), 0);
  const hintRows = withGap(hint.split('\n').length);
  const warningRows = warnings.length
    ? withGap(warnings.reduce((n, w) => n + wrappedRows(`▲ ${w}`, cols), 0))
    : 0;
  const optionRows = typing
    ? wrappedRows(APPROVAL_TYPING_LINE, cols)
    : APPROVAL_OPTIONS.reduce((n, label) => n + hangingRows(label, cols, OPTION_HANG), 0);
  const chrome =
    FRAME_ROWS +
    wrappedRows(`${DIALOG_MARKER} ${toolLabel(request.tool)}  ${request.subject}`, cols) +
    GAP_ROWS +
    warningRows +
    GAP_ROWS +
    optionRows;
  // Whatever the chrome, the warnings and the reserve leave of the viewport.
  const room = rows - 1 - BELOW_DIALOG_ROWS - reservedRows - chrome;
  const withHint = room - hintRows;
  if (withHint >= MIN_PREVIEW_ROWS) {
    return { previewRows: withHint, showHint: true, hint, height: chrome + hintRows + withHint };
  }
  // The hint is the one block nothing else depends on, so it pays for the preview — even when the
  // rows it frees still don't reach MIN_PREVIEW_ROWS: on a pane that narrow every row counts.
  const previewRows = Math.max(1, room);
  return { previewRows, showHint: false, hint, height: chrome + previewRows };
}

// The popup renders as the top half of one continuous frame whose bottom half is
// the input box (see Input's `attachedAbove`): `borderBottom={false}` + the input
// dropping its top border merges them into a single outline, so the prompt reads
// as part of the input region rather than a card floating above it. The frame
// stays neutral (no borderColor) to match the input; caution is signalled inside
// via themed `▲` warning lines, not a colored border.
export function Approval({
  request,
  selectedIndex,
  typing = false,
  width,
  rows = process.stdout.rows || 24,
  reservedRows = 0,
}: {
  request: ApprovalRequest;
  selectedIndex: number;
  // The reason is being typed: the input box underneath is live and is the field, as in Question.
  typing?: boolean;
  // Columns the rows may use; defaults to the live terminal width. Tests pass one to pin the wrap.
  width?: number;
  rows?: number;
  // Other live rows above the dialog (plan checklist, queued messages) the preview must leave room for.
  reservedRows?: number;
}) {
  const isCommand = request.tool === 'bash';
  const warnings = request.warnings ?? [];
  // `useContentWidth`, not a bare contentWidth(): the packing has to follow a resize, and this is
  // the width the dialog's own rows cost against — the same number the rows are drawn at.
  const liveWidth = useContentWidth(DIALOG_CHROME);
  const layoutWidth = width ?? liveWidth;
  const { previewRows, showHint, hint } = layoutApproval(
    request,
    typing,
    layoutWidth,
    rows,
    reservedRows,
  );
  return (
    <Box
      borderStyle={glyphs.border}
      borderBottom={false}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      marginX={-1}
      marginTop={1}
    >
      {/* One Text with nested runs (not siblings): on wrap Ink drops the char at
          a sibling boundary, which would clip a long subject. Mirrors the chat's
          tool-call line — `⏺︎ Bash` in tool grey, the subject receding in muted. */}
      <Text>
        {/* `toolLabel`, not a bare capitalize: an MCP tool's wire name (`mcp__srv__tool`) is not
            what the user typed or sees anywhere else, and the chip already spells it as the
            command. One rule for both, so the dialog and the scrollback cannot drift (#265). */}
        <Text color={theme.tool}>{`${DIALOG_MARKER} ${toolLabel(request.tool)}`}</Text>
        <Text color={theme.secondary}>{`  ${request.subject}`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {isCommand ? (
          <CommandPreview command={request.preview} maxRows={previewRows} width={layoutWidth} />
        ) : request.tool === 'fetch_url' ? (
          // A URL, not a diff: DiffView would draw it as one unchanged line with a gutter. It is
          // fitted like one all the same — a long URL wraps, and wrapping past the budget the
          // preview was sized to is exactly how the frame reached the viewport height.
          <UrlPreview url={request.preview} maxRows={previewRows} width={layoutWidth} />
        ) : (
          <DiffView
            diff={request.preview}
            path={request.subject}
            maxWidth={layoutWidth}
            startLine={request.startLine}
            maxRows={previewRows}
            hiddenNote={n => `… ${n} more lines — the full diff prints once approved`}
          />
        )}
      </Box>
      {warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {warnings.map((w, i) => (
            <Text key={i} color={theme.warning}>{`▲ ${w}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {typing ? (
          <Text color={theme.secondary}>{APPROVAL_TYPING_LINE}</Text>
        ) : (
          APPROVAL_OPTIONS.map((label, i) => {
            const selected = i === selectedIndex;
            return (
              <Text key={i}>
                <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
                {/* Pre-wrapped so a label that outgrows a narrow pane hangs under itself instead
                    of landing flush left under the marker (#167's shape), and so the rows the
                    layout counted above are the rows drawn. */}
                <Text color={selected ? theme.accent : undefined}>
                  {hangingWrap(label, layoutWidth, OPTION_HANG)}
                </Text>
              </Text>
            );
          })
        )}
      </Box>
      {/* Last out: on a pane too small for a preview and the hint, the hint is what goes — see
          layoutApproval. */}
      {showHint ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// A URL drawn as plain text, bounded to the rows the preview was given: it has no gutter and no
// line structure to fit, but it still wraps.
function UrlPreview({ url, maxRows, width }: { url: string; maxRows: number; width: number }) {
  const rows = wrapAnsi(url, Math.max(1, width), { trim: false, hard: true }).split('\n');
  if (rows.length <= maxRows) return <Text>{url}</Text>;
  // One row is the note's, as the diff and the command preview spend theirs, and what is left is
  // what the URL may take: a one-row preview is the note alone.
  const shown = rows.slice(0, Math.max(0, maxRows - 1));
  return (
    <>
      {shown.length > 0 ? <Text>{shown.join('\n')}</Text> : null}
      <Text color={theme.muted}>{`… ${rows.length - shown.length} more lines`}</Text>
    </>
  );
}

// The marker on a command's first row; every wrapped/extra line hangs under it by this width.
const MARKER = '$ ';
const MARKER_WIDTH = 2;

function CommandPreview({
  command,
  maxRows,
  width,
}: {
  command: string;
  maxRows: number;
  // The dialog's interior width, the same number the preview budget was measured against.
  width: number;
}) {
  // Sanitized like the scrollback chip (issue #154), but NOT scrubbed: this is the dialog where
  // the user decides whether to run the thing, so it must show the command as written, secrets
  // and all. Tabs and cursor motions still go — inside a bordered box they wrap past the border
  // and the frame comes apart around the very text being approved.
  const all = sanitizeTerminalText(command).split('\n');
  // Same width the rows are rendered at below, so the row counts fitted here are the row counts
  // the dialog actually draws.
  const textWidth = Math.max(1, width - MARKER_WIDTH);
  const { lines, hidden } = fitCommandLines(all, maxRows, textWidth);
  // Each logical line is pre-wrapped to the dialog width the way DiffView's WrappedRow does it
  // (#489): the `$`/`  ` marker and the text are adjacent siblings in a row Box, and when the row
  // is long enough to wrap, Ink drops the character at that sibling boundary — the space of `$ `,
  // which rendered every long approval as `$git checkout` with continuations back at column 0.
  // Wrapping ourselves keeps each row inside the width, so Ink never wraps one and the marker's
  // space survives; short commands were the only ones that kept their space before this.
  return (
    <>
      {lines.flatMap((line, i) => {
        const rows = wrapStyledRows(highlightCode(line, 'bash'), textWidth);
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
  // One row is the footer's when anything is cut, and the rows kept must stay INSIDE `maxRows`:
  // a preview budgeted one row draws the footer alone rather than a line plus a footer.
  const budget = Math.max(0, maxRows - 1);
  let used = 0;
  let kept = 0;
  while (kept < lines.length && used + heights[kept] <= budget) used += heights[kept++];
  return { lines: lines.slice(0, kept), hidden: lines.length - kept };
}
