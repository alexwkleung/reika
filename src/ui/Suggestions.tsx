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
  // Like Approval, this renders as the top half of one continuous frame whose
  // bottom half is the input box: `borderBottom={false}` + the input dropping its
  // top border (via `attachedAbove`) merges them, so the completion list reads as
  // part of the prompt you're typing into rather than a card floating above it.
  return (
    <Box borderStyle="round" borderBottom={false} flexDirection="column" paddingX={1} marginTop={1}>
      {state.items.map((item, i) => {
        const selected = i === selectedIndex;
        // One Text with nested runs (not siblings): on wrap Ink drops the char at
        // a sibling boundary, which would clip a long item.
        return (
          <Text key={i}>
            <Text bold color={selected ? theme.accent : undefined}>
              {selected ? '› ' : '  '}
            </Text>
            <Text bold={selected} color={selected ? theme.accent : undefined}>
              {truncate(item.display, maxDisplay)}
            </Text>
          </Text>
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
