import { Box, Text } from 'ink';
import type { QuestionRequest } from '../types.js';
import { theme } from './theme.js';

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
}: {
  request: QuestionRequest;
  selectedIndex: number;
  typing?: QuestionTyping | null;
}) {
  const noting = typing && typing.forIndex !== undefined ? request.options[typing.forIndex] : null;
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
        <Box flexDirection="column" marginTop={1}>
          {request.options.map((o, i) => {
            const selected = i === selectedIndex;
            return (
              <Box key={i} flexDirection="column">
                {/* One Text with nested runs (not siblings): on wrap Ink drops the char at a
                    sibling boundary, which would clip a long label — and labels here are
                    deliberately full sentences. */}
                <Text>
                  <Text bold color={selected ? theme.accent : undefined}>
                    {selected ? '› ' : '  '}
                  </Text>
                  <Text bold={selected} color={selected ? theme.accent : undefined}>
                    {o.label}
                  </Text>
                  {o.recommended ? <Text color={theme.info}>{'  (recommended)'}</Text> : null}
                </Text>
                {o.description ? <Text color={theme.muted}>{`    ${o.description}`}</Text> : null}
              </Box>
            );
          })}
          <Text>
            <Text bold color={selectedIndex === request.options.length ? theme.accent : undefined}>
              {selectedIndex === request.options.length ? '› ' : '  '}
            </Text>
            <Text
              bold={selectedIndex === request.options.length}
              color={selectedIndex === request.options.length ? theme.accent : theme.secondary}
            >
              {OWN_ANSWER_LABEL}
            </Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {typing
            ? 'enter submit  ·  ctrl-c abort'
            : '↑↓ navigate  ·  enter select  ·  tab add a note  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}
