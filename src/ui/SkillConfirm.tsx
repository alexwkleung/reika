import { Box, Text } from 'ink';
import type { SkillMatch } from '../skillmatch.js';
import { theme } from './theme.js';

// Row 0 is "send as typed" and starts selected — the inverse of Approval, where Approve is row 0.
// There the model has already committed to an action; here nothing has happened yet and the
// literal prompt is what was asked for. A wrong default that injects costs a turn; a wrong
// default that doesn't costs a keystroke.
export const SKILL_CONFIRM_SEND = 0;
export const SKILL_CONFIRM_APPLY = 1;
export type SkillConfirmChoice = typeof SKILL_CONFIRM_SEND | typeof SKILL_CONFIRM_APPLY;

export function skillConfirmOptions(match: SkillMatch): [string, string] {
  return ['Send as typed', `Apply /${match.skill.name}`];
}

// The harness asking before submit — the third modal kind next to Approval (act on a model
// action) and Question (the model asks). Same merged frame as those (`borderBottom={false}` over
// the input, see Input's `attachedAbove`): it fires at submit, and the prompt it is asking about
// is still sitting in the input underneath.
export function SkillConfirm({
  match,
  selectedIndex,
}: {
  match: SkillMatch;
  selectedIndex: number;
}) {
  const options = skillConfirmOptions(match);
  return (
    <Box
      borderStyle="round"
      borderBottom={false}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      marginX={-1}
      marginTop={1}
    >
      {/* One Text with nested runs, as in Approval: a sibling boundary loses a char on wrap. */}
      <Text>
        <Text bold color={theme.tool}>{`⏺︎ Skill`}</Text>
        <Text color={theme.secondary}>{`  /${match.skill.name} — ${match.skill.description}`}</Text>
      </Text>
      <Text color={theme.muted}>{`  matched: ${match.matched.join(', ')}`}</Text>
      {/* Numbered like the question dialog: a two-row picker without numbers reads as a different
          widget from the one users already learned there. A digit only moves the cursor. */}
      <Box flexDirection="column" marginTop={1}>
        {options.map((label, i) => {
          const selected = i === selectedIndex;
          return (
            <Text key={i}>
              <Text bold color={selected ? theme.accent : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={selected ? theme.accent : theme.secondary}>{`${i + 1}. `}</Text>
              <Text bold={selected} color={selected ? theme.accent : undefined}>
                {label}
              </Text>
            </Text>
          );
        })}
      </Box>
      {/* Says where y lands, since the row order inverts Approval's and approval-trained fingers
          would otherwise expect it on row 0. y/n only move, like the digits: Enter is the one key
          that answers. */}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {'↑↓ or 1-2 navigate  ·  y/n jump (y = apply)  ·  enter select  ·  ctrl-c abort'}
        </Text>
      </Box>
    </Box>
  );
}
