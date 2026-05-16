import React from 'react';
import { Box, Text } from 'ink';
import type { SuggestionState } from './suggest.js';

export function Suggestions({
  state,
  selectedIndex,
}: {
  state: SuggestionState;
  selectedIndex: number;
}) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
      {state.items.map((item, i) => (
        <Text key={i} bold={i === selectedIndex}>
          {`${i === selectedIndex ? '› ' : '  '}${item.display}`}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{'↑↓ navigate  ·  tab accept  ·  esc dismiss'}</Text>
      </Box>
    </Box>
  );
}
