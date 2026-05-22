import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import type { ApprovalRequest } from '../types.js';
import { theme } from './theme.js';
import { DiffView } from './DiffView.js';

export const APPROVAL_OPTIONS = ['Approve', 'Decline', 'Always (this session)'] as const;
export type ApprovalChoice = 0 | 1 | 2;

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
      borderColor={theme.warning}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      marginTop={1}
    >
      <Text bold>{`${request.tool}  ${request.subject}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {isCommand ? (
          <CommandPreview command={request.preview} />
        ) : (
          <DiffView
            diff={request.preview}
            path={request.subject}
            maxWidth={Math.max(20, (process.stdout.columns || 80) - 6)}
          />
        )}
      </Box>
      {warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">
            {'WARNING'}
          </Text>
          {warnings.map((w, i) => (
            <Text key={i} bold>{`  · ${w}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((label, i) => {
          const selected = i === selectedIndex;
          return (
            <Box key={i}>
              <Text bold color={selected ? theme.accent : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text bold={selected}>{label}</Text>
            </Box>
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
  const lines = command.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="green">{i === 0 ? '$ ' : '  '}</Text>
          <Text>{safeHighlight(line, 'bash')}</Text>
        </Box>
      ))}
    </>
  );
}

function safeHighlight(code: string, language: string): string {
  if (!code.trim()) return code;
  try {
    return highlight(code, { language, ignoreIllegals: true });
  } catch {
    return code;
  }
}
