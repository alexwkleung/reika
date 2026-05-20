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
  // Reserve a few cols for the round border, paddingX, and the `› ` marker.
  const termWidth = process.stdout.columns || 100;
  const maxDisplay = Math.max(20, termWidth - 8);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
      {state.items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={i}>
            <Text bold color={selected ? theme.accent : undefined}>
              {selected ? '› ' : '  '}
            </Text>
            <Text bold={selected}>{truncate(item.display, maxDisplay)}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.muted}>{'↑↓ navigate  ·  tab accept  ·  esc dismiss'}</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
