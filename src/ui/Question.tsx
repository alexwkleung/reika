import { Box, Text } from 'ink';
import type { QuestionRequest } from '../types.js';
import { hangingWrap, useContentWidth } from './layout.js';
import { theme } from './theme.js';

// The dialog's own border plus its paddingX={1}, on top of the App padding contentWidth already
// accounts for — the same chrome Approval pays for its diff.
const DIALOG_CHROME = 4;

// Label shown for the row that hands the answer over to the input box. It is always last and always
// present: the model's three options being collectively wrong is the real risk of a menu, and this
// row is what makes that recoverable in one keystroke instead of an aborted turn.
export const OWN_ANSWER_LABEL = 'Something else — type your own answer';

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
}: {
  request: QuestionRequest;
  selectedIndex: number;
  typing?: QuestionTyping | null;
  // Columns the rows may use; defaults to the live terminal width. Tests pass one to pin the wrap.
  width?: number;
}) {
  const liveWidth = useContentWidth(DIALOG_CHROME);
  const cols = width ?? liveWidth;
  const noting = typing && typing.forIndex !== undefined ? request.options[typing.forIndex] : null;
  // Labels are full sentences and wrap on any ordinary terminal. Ink has no hanging indent, so a
  // continuation row would land flush left under the marker, detached from its number
  // (issue #167's shape). Pre-wrapping each row keeps every continuation under the label text.
  const hang = '› 1. '.length;
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
      <Text bold color={theme.tool}>
        {'• Question'}
      </Text>
      <Box marginTop={1}>
        <Text>{request.question}</Text>
      </Box>
      {typing ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.secondary}>
            {noting ? `Adding a note to: ${noting.label}` : 'Type your answer below.'}
          </Text>
        </Box>
      ) : (
        // Numbered so a row with a description reads as one entry and the list as a list — four
        // full-sentence labels with indented sub-lines otherwise ran together as a paragraph.
        <Box flexDirection="column" marginTop={1}>
          {request.options.map((o, i) => {
            const selected = i === selectedIndex;
            const num = `${i + 1}. `;
            const tag = o.recommended ? '  (recommended)' : '';
            // Wrapped as one string so the tag can't be pushed onto its own flush-left row, then
            // split back at the tag so it keeps its own color.
            const wrapped = hangingWrap(o.label + tag, cols, hang);
            const tagAt = tag ? wrapped.lastIndexOf(tag.trimStart()) : -1;
            const label = tagAt >= 0 ? wrapped.slice(0, tagAt) : wrapped;
            return (
              <Box key={i} flexDirection="column">
                {/* One Text with nested runs (not siblings): on wrap Ink drops the char at a
                    sibling boundary, which would clip a long label — and labels here are
                    deliberately full sentences. */}
                <Text>
                  <Text bold color={selected ? theme.accent : undefined}>
                    {selected ? '› ' : '  '}
                  </Text>
                  <Text color={selected ? theme.accent : theme.secondary}>{num}</Text>
                  <Text bold={selected} color={selected ? theme.accent : undefined}>
                    {label}
                  </Text>
                  {tagAt >= 0 ? <Text color={theme.info}>{wrapped.slice(tagAt)}</Text> : null}
                </Text>
                {o.description ? (
                  <Text color={theme.muted}>
                    {' '.repeat(hang) + hangingWrap(o.description, cols, hang)}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          <Text>
            <Text bold color={selectedIndex === request.options.length ? theme.accent : undefined}>
              {selectedIndex === request.options.length ? '› ' : '  '}
            </Text>
            <Text color={selectedIndex === request.options.length ? theme.accent : theme.secondary}>
              {`${request.options.length + 1}. `}
            </Text>
            <Text
              bold={selectedIndex === request.options.length}
              color={selectedIndex === request.options.length ? theme.accent : theme.secondary}
            >
              {hangingWrap(OWN_ANSWER_LABEL, cols, hang)}
            </Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {typing
            ? 'enter submit  ·  ctrl-c abort'
            : '↑↓ or 1-9 navigate  ·  enter select  ·  tab add a note  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}
