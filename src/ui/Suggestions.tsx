import { Box, Text } from 'ink';
import type { SuggestionState } from './suggest.js';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';

const MAX_VISIBLE_SUGGESTIONS = 8;

// How many items the list shows at once. A bare `/` matches every command and skill (25+ rows),
// and the list lives in Ink's dynamic frame: at viewport height Ink repaints the whole terminal,
// `\x1b[3J` included (#470 — mid-turn, beside a live stream, that is every chunk). So the list is
// a window that scrolls with the selection, shrinking on a short terminal. The 22 rows are what a
// busy frame needs besides it: Scrollback's chrome and safety (10) plus a reasoning and a content
// block at their minimum shares (~9), with the list's own three.
export function visibleSuggestionCount(rows = process.stdout.rows || 24): number {
  return Math.max(3, Math.min(MAX_VISIBLE_SUGGESTIONS, rows - 22));
}

// The window's first index: the selection stays inside it, scrolling one row at a time.
export function suggestionWindowStart(total: number, selected: number, visible: number): number {
  if (total <= visible) return 0;
  return Math.min(Math.max(0, selected - visible + 1), total - visible);
}

// Rows the list adds below the input: its items, the footer and the footer's margin, and the
// bottom border. The input drops its own bottom border when the list is attached, so it is even.
export function suggestionRows(state: SuggestionState | null): number {
  if (!state || state.items.length === 0) return 0;
  return Math.min(state.items.length, visibleSuggestionCount()) + 3;
}

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
  const visible = visibleSuggestionCount();
  const total = state.items.length;
  const start = suggestionWindowStart(total, selectedIndex, visible);
  // Renders as the bottom half of one continuous frame whose top half is the
  // input box: `borderTop={false}` + the input dropping its bottom border (via
  // `attachedBelow`) merges them, so the completion list reads as part of the
  // prompt you're typing into rather than a card floating nearby. Below rather
  // than above (unlike Approval) because the eye is already on the input line
  // and a long list reads more naturally dropping down from it than stacking up.
  return (
    <Box
      borderStyle={glyphs.border}
      borderTop={false}
      flexDirection="column"
      paddingX={1}
      marginX={-1}
    >
      {state.items.slice(start, start + visible).map((item, j) => {
        const selected = start + j === selectedIndex;
        // One Text with nested runs (not siblings): on wrap Ink drops the char at
        // a sibling boundary, which would clip a long item.
        return (
          <Text key={start + j}>
            <Text color={selected ? theme.accent : undefined}>
              {start + visible < total && j === visible - 1 ? '↓ ' : selected ? '› ' : '  '}
            </Text>
            <Text color={selected ? theme.accent : undefined}>
              {truncate(item.display, maxDisplay)}
            </Text>
          </Text>
        );
      })}
      <Box marginTop={1}>
        {/* The position rides the footer rather than an extra row, so scrolling never changes the
            list's height. */}
        <Text color={theme.muted}>
          {'↑↓ navigate  ·  tab/enter accept  ·  esc dismiss'}
          {total > visible ? `  ·  ${selectedIndex + 1}/${total}` : ''}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
