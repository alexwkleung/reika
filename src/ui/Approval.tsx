import React from 'react';
import { Box, Text } from 'ink';
import type { ApprovalRequest } from '../types.js';

export function Approval({ request }: { request: ApprovalRequest }) {
  const lines = request.diff.split('\n');
  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Text bold>{`${request.tool}  ${request.path}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{'[y] approve  ·  [n] decline  ·  ctrl-c abort'}</Text>
      </Box>
    </Box>
  );
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+ ')) {
    return (
      <Box>
        <Text color="green">{'+ '}</Text>
        <Text>{line.slice(2)}</Text>
      </Box>
    );
  }
  if (line.startsWith('- ')) {
    return (
      <Box>
        <Text color="red">{'- '}</Text>
        <Text dimColor>{line.slice(2)}</Text>
      </Box>
    );
  }
  return <Text dimColor>{line}</Text>;
}
