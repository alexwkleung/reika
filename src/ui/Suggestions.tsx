import React from 'react';
import { Box, Text } from 'ink';
import type { SuggestionState } from './suggest.js';
import { theme } from './theme.js';

export function Suggestions({
  state,
  selectedIndex,
}: {
  state: SuggestionState;
  selectedIndex: number;
}) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
      {state.items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={i}>
            <Text bold color={selected ? theme.accent : undefined}>
              {selected ? '› ' : '  '}
            </Text>
            <Text bold={selected}>{item.display}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.muted}>{'↑↓ navigate  ·  tab accept  ·  esc dismiss'}</Text>
      </Box>
    </Box>
  );
}
