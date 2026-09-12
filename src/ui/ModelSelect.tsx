import { Box, Text } from 'ink';
import type { ModelTarget } from './models.js';
import { theme } from './theme.js';

// Interactive /model picker. Like Approval and Suggestions, this renders as the
// top half of one continuous frame whose bottom half is the input box
// (`borderBottom={false}` + the input's `attachedAbove`), so the list reads as
// part of the prompt region rather than a card floating above it.
export function ModelSelect({
  targets,
  selectedIndex,
  currentModel,
  baseURL,
  subagent,
}: {
  targets: ModelTarget[];
  selectedIndex: number;
  // The active profile's resolved model and the default base URL, shown as
  // header context (what the old printed list surfaced).
  currentModel: string;
  baseURL: string;
  subagent?: string;
}) {
  // Reserve a few cols for the round border, paddingX, and the `› ` marker.
  const termWidth = process.stdout.columns || 100;
  const maxDisplay = Math.max(20, termWidth - 8);
  return (
    <Box
      borderStyle="round"
      borderBottom={false}
      flexDirection="column"
      paddingX={1}
      marginX={-1}
      marginTop={1}
    >
      <Text>
        <Text bold color={theme.tool}>
          {'• Model'}
        </Text>
        <Text color={theme.secondary}>{`  ${currentModel}`}</Text>
      </Text>
      <Text color={theme.muted}>{`  base: ${baseURL}`}</Text>
      {subagent ? <Text color={theme.muted}>{`  subagent: ${subagent}`}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {targets.map((t, i) => {
          const selected = i === selectedIndex;
          // Auto-registered model entries read best as the bare model name; a
          // named profile shows its mapping. Ad-hoc entries (a /model name not
          // in the config) are keyed by their own lowercased model, so the
          // mapping would be noise — bare name plus the off-config marker. A
          // profile living on another base URL says so — that's the detail that
          // makes switching to it a different thing than switching models on
          // the default server.
          const offBase = t.kind === 'profile' && t.baseURL !== baseURL;
          const label = t.kind === 'profile' && !t.adhoc ? `${t.name} → ${t.model}` : t.model;
          // One Text with nested runs (not siblings): on wrap Ink drops the
          // char at a sibling boundary, which would clip a long label.
          return (
            <Text key={i}>
              <Text bold color={selected ? theme.accent : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text bold={selected} color={selected ? theme.accent : undefined}>
                {truncate(label, maxDisplay)}
              </Text>
              {offBase ? <Text color={theme.muted}>{`  @ ${t.baseURL}`}</Text> : null}
              {t.adhoc ? <Text color={theme.muted}>{'  (not in config)'}</Text> : null}
              {t.active ? <Text color={theme.muted}>{'  (current)'}</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{'↑↓ navigate  ·  enter switch  ·  esc cancel'}</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
