import { Box, Text } from 'ink';
import type { SessionEntry } from '../store/sessions.js';
import { theme } from './theme.js';

// A project can collect hundreds of sessions, and the picker lives in the dynamic frame, where a
// frame as tall as the viewport repaints the whole terminal (see Scrollback.tsx). So the list is
// a fixed-height window that scrolls with the cursor.
export const RESUME_VISIBLE_ROWS = 8;

// Interactive /resume picker. Same frame as ModelSelect: the top half of one continuous box whose
// bottom half is the input.
export function ResumeSelect({
  entries,
  selectedIndex,
  heading,
}: {
  entries: SessionEntry[];
  selectedIndex: number;
  // Which list this is ("this project", "saved (root)"), since the project list falls back to root.
  heading: string;
}) {
  const termWidth = process.stdout.columns || 100;
  const maxDisplay = Math.max(20, termWidth - 8);
  const start = windowStart(entries.length, selectedIndex, RESUME_VISIBLE_ROWS);
  const shown = entries.slice(start, start + RESUME_VISIBLE_ROWS);
  const below = entries.length - start - shown.length;
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
          {'• Resume'}
        </Text>
        <Text color={theme.secondary}>{`  ${heading} · ${entries.length}`}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted}>{start > 0 ? `  ↑ ${start} newer` : ' '}</Text>
        {shown.map((e, i) => {
          const selected = start + i === selectedIndex;
          const when = formatSavedAt(e.savedAt);
          const label = e.title ?? '(untitled)';
          // The model is what tells apart two sessions opened with the same prompt.
          const tail = `  ${e.messageCount} msgs${e.model ? ` · ${e.model}` : ''}`;
          const budget = Math.max(10, maxDisplay - when.length - tail.length - 2);
          // One Text with nested runs: on wrap Ink drops the char at a sibling boundary.
          return (
            <Text key={e.path}>
              <Text bold color={selected ? theme.accent : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={theme.muted}>{`${when}  `}</Text>
              <Text bold={selected} color={selected ? theme.accent : undefined}>
                {truncate(label, budget)}
              </Text>
              <Text color={theme.muted}>{tail}</Text>
            </Text>
          );
        })}
        <Text color={theme.muted}>{below > 0 ? `  ↓ ${below} older` : ' '}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{'↑↓ navigate  ·  enter resume  ·  esc cancel'}</Text>
      </Box>
    </Box>
  );
}

// Keeps the cursor inside the window, scrolling only when it would leave it.
export function windowStart(total: number, selected: number, rows: number): number {
  if (total <= rows) return 0;
  return Math.min(Math.max(0, selected - Math.floor(rows / 2)), total - rows);
}

// `2026-09-22 14:05`, local time. The save stamp is ISO UTC; a list is read by wall clock.
export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
