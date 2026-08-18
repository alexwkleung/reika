import { Box, Text } from 'ink';
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
}: {
  request: ApprovalRequest;
  selectedIndex: number;
}) {
  const isCommand = request.tool === 'bash';
  const warnings = request.warnings ?? [];
  return (
    <Box
      borderStyle="round"
      borderBottom={false}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      marginTop={1}
    >
      {/* One Text with nested runs (not siblings): on wrap Ink drops the char at
          a sibling boundary, which would clip a long subject. Mirrors the chat's
          tool-call line — `• Bash` in tool grey, the subject receding in muted. */}
      <Text>
        <Text bold color={theme.tool}>{`• ${capitalize(request.tool)}`}</Text>
        <Text color={theme.secondary}>{`  ${request.subject}`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {isCommand ? (
          <CommandPreview command={request.preview} />
        ) : (
          <DiffView
            diff={request.preview}
            path={request.subject}
            maxWidth={contentWidth(DIALOG_CHROME)}
            startLine={request.startLine}
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

function CommandPreview({ command }: { command: string }) {
  // Sanitized like the scrollback chip (issue #154), but NOT scrubbed: this is the dialog where
  // the user decides whether to run the thing, so it must show the command as written, secrets
  // and all. Tabs and cursor motions still go — inside a bordered box they wrap past the border
  // and the frame comes apart around the very text being approved.
  const lines = sanitizeTerminalText(command).split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.success}>{i === 0 ? '$ ' : '  '}</Text>
          <Text>{highlightCode(line, 'bash')}</Text>
        </Box>
      ))}
    </>
  );
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
