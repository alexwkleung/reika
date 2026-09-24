import { Box, Text } from 'ink';
import type { SkillMatch } from '../skillmatch.js';
import { theme } from './theme.js';

// Row 0 is "send as typed" and starts selected — the inverse of Approval, where Approve is row 0.
// There the model has already committed to an action; here nothing has happened yet and the
// literal prompt is what was asked for. A wrong default that acts costs a turn (or a request
// nobody meant); a wrong default that doesn't costs a keystroke.
export const CONFIRM_DECLINE = 0;
export const CONFIRM_ACCEPT = 1;

// What the harness is asking about. Two askers share the dialog: a strongly matched skill (#425)
// and a pasted link the prompt is not obviously about (#448). Same frame, same keys, same row
// order — the user learns one widget.
export type ConfirmSpec = {
  // `• <title>` in the tool color, `<subtitle>` beside it in secondary.
  title: string;
  subtitle: string;
  // Muted lines under the header: the matched phrases, the links.
  details: string[];
  options: [string, string];
  // The footer's "y = <accept>" word.
  accept: string;
};

export function skillConfirmSpec(match: SkillMatch): ConfirmSpec {
  return {
    title: 'Skill',
    subtitle: `/${match.skill.name} — ${match.skill.description}`,
    details: [`matched: ${match.matched.join(', ')}`],
    options: ['Send as typed', `Apply /${match.skill.name}`],
    accept: 'apply',
  };
}

// A long URL wraps the frame; the user just typed it, so the head is enough to recognize it.
const URL_DISPLAY_CHARS = 90;

export function pastedUrlConfirmSpec(urls: string[]): ConfirmSpec {
  const n = urls.length;
  return {
    title: n > 1 ? 'Pasted links' : 'Pasted link',
    subtitle: `the prompt doesn't read as a request to open ${n > 1 ? 'them' : 'it'} — fetch before the turn?`,
    details: urls.map(u =>
      u.length > URL_DISPLAY_CHARS ? `${u.slice(0, URL_DISPLAY_CHARS)}…` : u,
    ),
    options: ['Send as typed', `Fetch ${n > 1 ? `${n} links` : 'the link'}`],
    accept: 'fetch',
  };
}

// The harness asking before submit — the third modal kind next to Approval (act on a model
// action) and Question (the model asks). Same merged frame as those (`borderBottom={false}` over
// the input, see Input's `attachedAbove`): it fires at submit, and the prompt it is asking about
// is still sitting in the input underneath.
export function Confirm({ spec, selectedIndex }: { spec: ConfirmSpec; selectedIndex: number }) {
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
        <Text color={theme.tool}>{`• ${spec.title}`}</Text>
        <Text color={theme.secondary}>{`  ${spec.subtitle}`}</Text>
      </Text>
      {spec.details.map((line, i) => (
        <Text key={i} color={theme.muted}>{`  ${line}`}</Text>
      ))}
      {/* Numbered like the question dialog: a two-row picker without numbers reads as a different
          widget from the one users already learned there. A digit only moves the cursor. */}
      <Box flexDirection="column" marginTop={1}>
        {spec.options.map((label, i) => {
          const selected = i === selectedIndex;
          return (
            <Text key={i}>
              <Text color={selected ? theme.accent : undefined}>{selected ? '› ' : '  '}</Text>
              <Text color={selected ? theme.accent : theme.secondary}>{`${i + 1}. `}</Text>
              <Text color={selected ? theme.accent : undefined}>{label}</Text>
            </Text>
          );
        })}
      </Box>
      {/* Says where y lands, since the row order inverts Approval's and approval-trained fingers
          would otherwise expect it on row 0. y/n only move, like the digits: Enter is the one key
          that answers. */}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {`↑↓ or 1-2 navigate  ·  y/n jump (y = ${spec.accept})  ·  enter select  ·  ctrl-c abort`}
        </Text>
      </Box>
    </Box>
  );
}
