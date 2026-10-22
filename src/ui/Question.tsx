import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { QuestionRequest } from '../types.js';
import { contentWidth, hangingWrap, useContentWidth } from './layout.js';
import { DIALOG_MARKER } from './Approval.js';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';

// The dialog's own border plus its paddingX={1}, on top of the App padding contentWidth already
// accounts for — the same chrome Approval pays for its diff.
const DIALOG_CHROME = 4;

// Label shown for the row that hands the answer over to the input box. It is always last and always
// present: the model's three options being collectively wrong is the real risk of a menu, and this
// row is what makes that recoverable in one keystroke instead of an aborted turn.
export const OWN_ANSWER_LABEL = 'Something else — type your own answer';

// The dialog sits in Ink's live frame, and every word in it is model-written: a frame as tall as
// the viewport makes Ink repaint with `\x1b[3J` and strands the dialog in the scrollback (#456,
// the #447 shape). Fixed rows: marginTop, top border, both paddingY rows, the header, the margins
// above the question, the options and the hint, and the hint — then the input and status bar
// underneath, plus slack.
const DIALOG_FIXED_ROWS = 9;
const BELOW_DIALOG_ROWS = 6;
// While the user types, the input under the dialog is live and scrolls its own window once the
// answer outgrows the room the dialog leaves it (App passes `questionDialogHeight` to Input). That
// window never goes below three lines plus its two "… lines above/below" markers, so the question
// holds those rows back — the input can't be squeezed into overflowing the frame.
const TYPING_INPUT_ROWS = 4;

// What fits, in the order things are given up: the options are what the user acts on, so every
// option row and the own-answer row always show; descriptions go first, then the question's tail.
// Exported for unit tests.
export function fitQuestionToHeight(
  questionRows: number,
  labelRows: number,
  descriptionRows: number,
  budget: number,
): { showDescriptions: boolean; questionRows: number } {
  if (questionRows + labelRows + descriptionRows <= budget) {
    return { showDescriptions: true, questionRows };
  }
  if (questionRows + labelRows <= budget) return { showDescriptions: false, questionRows };
  // One row goes to the "more lines" note, and the question keeps at least its first row.
  return { showDescriptions: false, questionRows: Math.max(1, budget - labelRows - 1) };
}

// Typing state, mirrored from App. `forIndex` set means the user picked that option and is adding a
// note to it; undefined means they are writing the whole answer themselves.
export type QuestionTyping = { forIndex?: number };

// Renders as the top half of one continuous frame whose bottom half is the input box (see
// Approval/ModelSelect for the same `borderBottom={false}` + `attachedAbove` merge). Unlike those
// two, the input stays LIVE underneath while typing — the question is a prompt for text, and
// reusing Input gets editing, history and paste for free rather than rebuilding a field in here.
export function Question({
  request,
  selectedIndex,
  typing,
  width,
  rows = process.stdout.rows || 24,
  reservedRows = 0,
}: {
  request: QuestionRequest;
  selectedIndex: number;
  typing?: QuestionTyping | null;
  // Columns the rows may use; defaults to the live terminal width. Tests pass one to pin the wrap.
  width?: number;
  rows?: number;
  // Other live rows above the dialog (plan checklist, queued messages) it must leave room for.
  reservedRows?: number;
}) {
  const liveWidth = useContentWidth(DIALOG_CHROME);
  const { labels, descriptions, ownAnswer, questionLines, typingLine, fit, hiddenQuestionRows } =
    layoutQuestion(request, typing ?? null, width ?? liveWidth, rows, reservedRows);
  const hang = HANG;
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
      {/* ask_user is a tool call, so it wears the tool-call marker like Approval does. */}
      <Text color={theme.tool}>{`${DIALOG_MARKER} Question`}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{questionLines.slice(0, fit.questionRows).join('\n')}</Text>
        {hiddenQuestionRows > 0 ? (
          <Text color={theme.muted}>{`… ${hiddenQuestionRows} more lines`}</Text>
        ) : null}
      </Box>
      {typing ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.secondary}>{typingLine}</Text>
        </Box>
      ) : (
        // Numbered so a row with a description reads as one entry and the list as a list — four
        // full-sentence labels with indented sub-lines otherwise ran together as a paragraph.
        <Box flexDirection="column" marginTop={1}>
          {request.options.map((o, i) => {
            const selected = i === selectedIndex;
            const num = `${i + 1}. `;
            // Wrapped as one string so the tag can't be pushed onto its own flush-left row, then
            // split back at the tag so it keeps its own color.
            const { tag, wrapped } = labels[i];
            const tagAt = tag ? wrapped.lastIndexOf(tag.trimStart()) : -1;
            const label = tagAt >= 0 ? wrapped.slice(0, tagAt) : wrapped;
            return (
              <Box key={i} flexDirection="column">
                {/* One Text with nested runs (not siblings): on wrap Ink drops the char at a
                    sibling boundary, which would clip a long label — and labels here are
                    deliberately full sentences. */}
                <Text>
                  <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
                  <Text color={selected ? theme.accent : theme.secondary}>{num}</Text>
                  <Text color={selected ? theme.accent : undefined}>{label}</Text>
                  {tagAt >= 0 ? <Text color={theme.info}>{wrapped.slice(tagAt)}</Text> : null}
                </Text>
                {fit.showDescriptions && descriptions[i] ? (
                  <Text color={theme.muted}>{' '.repeat(hang) + descriptions[i]}</Text>
                ) : null}
              </Box>
            );
          })}
          <Text>
            <Text color={selectedIndex === request.options.length ? theme.accent : undefined}>
              {selectedIndex === request.options.length ? '› ' : '  '}
            </Text>
            <Text color={selectedIndex === request.options.length ? theme.accent : theme.secondary}>
              {`${request.options.length + 1}. `}
            </Text>
            <Text color={selectedIndex === request.options.length ? theme.accent : theme.secondary}>
              {ownAnswer}
            </Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {typing
            ? 'enter submit  ·  ctrl-c back to the options'
            : '↑↓ or 1-9 navigate  ·  enter select  ·  tab add a note  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}

// Labels are full sentences and wrap on any ordinary terminal. Ink has no hanging indent, so a
// continuation row would land flush left under the marker, detached from its number
// (issue #167's shape). Pre-wrapping each row keeps every continuation under the label text.
const HANG = '› 1. '.length;

// Everything the dialog draws, pre-wrapped and fitted to the viewport, plus the height it comes to.
// App calls it too, so the input underneath knows how much room the dialog leaves it.
export function layoutQuestion(
  request: QuestionRequest,
  typing: QuestionTyping | null,
  cols: number,
  rows: number,
  reservedRows: number,
) {
  const hang = HANG;
  const noting = typing && typing.forIndex !== undefined ? request.options[typing.forIndex] : null;
  const labels = request.options.map(o => {
    const tag = o.recommended ? '  (recommended)' : '';
    return { tag, wrapped: hangingWrap(o.label + tag, cols, hang) };
  });
  const descriptions = request.options.map(o =>
    o.description ? hangingWrap(o.description, cols, hang) : null,
  );
  const ownAnswer = hangingWrap(OWN_ANSWER_LABEL, cols, hang);
  const rowsOf = (text: string): number => text.split('\n').length;
  const wrapRows = (text: string): string[] =>
    wrapAnsi(text, Math.max(1, cols), { trim: false, hard: true }).split('\n');
  const questionLines = wrapRows(request.question);
  const typingLine = wrapRows(
    noting ? `Adding a note to: ${noting.label}` : 'Type your answer below.',
  ).join('\n');
  const labelRows = typing
    ? rowsOf(typingLine)
    : labels.reduce((n, l) => n + rowsOf(l.wrapped), 0) + rowsOf(ownAnswer);
  const descriptionRows = typing ? 0 : descriptions.reduce((n, d) => n + (d ? rowsOf(d) : 0), 0);
  const below = BELOW_DIALOG_ROWS + (typing ? TYPING_INPUT_ROWS : 0);
  const fit = fitQuestionToHeight(
    questionLines.length,
    labelRows,
    descriptionRows,
    rows - DIALOG_FIXED_ROWS - below - reservedRows,
  );
  const hiddenQuestionRows = questionLines.length - fit.questionRows;
  const height =
    DIALOG_FIXED_ROWS +
    fit.questionRows +
    (hiddenQuestionRows > 0 ? 1 : 0) +
    labelRows +
    (fit.showDescriptions ? descriptionRows : 0);
  return {
    labels,
    descriptions,
    ownAnswer,
    questionLines,
    typingLine,
    fit,
    hiddenQuestionRows,
    height,
  };
}

// The dialog's height at the live terminal size, for the input underneath it.
export function questionDialogHeight(
  request: QuestionRequest,
  typing: QuestionTyping | null,
  reservedRows: number,
): number {
  return layoutQuestion(
    request,
    typing,
    contentWidth(DIALOG_CHROME),
    process.stdout.rows || 24,
    reservedRows,
  ).height;
}
