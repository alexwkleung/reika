import { Box, Text } from 'ink';
import type { SkillMatch } from '../skillmatch.js';
import { IMPLEMENT_MODES, type ImplementMode } from './commands.js';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';

// Row 0 is "send as typed" and starts selected — the inverse of Approval, where Approve is row 0.
// There the model has already committed to an action; here nothing has happened yet and the
// literal prompt is what was asked for. A wrong default that acts costs a turn (or a request
// nobody meant); a wrong default that doesn't costs a keystroke.
export const CONFIRM_DECLINE = 0;
export const CONFIRM_ACCEPT = 1;

// What the harness is asking about. Three askers share the dialog: a strongly matched skill
// (#425), a pasted link the prompt is not obviously about (#448), and the mode /implement runs in
// (#561). Same frame, same keys, row 0 the default — the user learns one widget.
export type ConfirmSpec = {
  // `• <title>` in the tool color, `<subtitle>` beside it in secondary.
  title: string;
  subtitle: string;
  // Muted lines under the header: the matched phrases, the links.
  details: string[];
  options: string[];
  // The footer's "y = <accept>" word, for a yes/no ask whose accepting row is CONFIRM_ACCEPT. A
  // pick among peers has no "yes", so it binds no y/n.
  accept?: string;
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

const IMPLEMENT_MODE_LABELS: Record<ImplementMode, string> = {
  agent: 'Agent — full tool set',
  minimal: 'Minimal — shell only, no repo map or AGENTS.md',
  grind: 'Grind — fixed procedure, proves the change by running checks',
};

// The toggle dialogs for /approvals, /unattended and /anon (#625): a bare command without on/off
// asks instead of printing the arg-less default. Row 0 is 'on', row 1 'off', row 2 'Cancel',
// fixed across opens so the digits stay stable; which row starts selected follows the current
// state, so a bare Enter (or the digit for the current state) changes nothing — the same
// default-as-least-action rule as the other picks.
export const TOGGLE_ON = 0;
export const TOGGLE_OFF = 1;
export const TOGGLE_CANCEL = 2;

export function toggleConfirmSpec(opts: { title: string; subtitle: string }): ConfirmSpec {
  return {
    title: opts.title,
    subtitle: opts.subtitle,
    details: [],
    options: ['on', 'off', 'Cancel'],
  };
}

// Agent is row 0, so Enter alone keeps the one-keystroke /implement it always was.
export function implementModeConfirmSpec(): ConfirmSpec {
  return {
    title: 'Implement',
    subtitle: 'which mode should carry out the plan?',
    details: [],
    options: IMPLEMENT_MODES.map(m => IMPLEMENT_MODE_LABELS[m]),
  };
}

// The harness asking before submit — the third modal kind next to Approval (act on a model
// action) and Question (the model asks). Same merged frame as those (`borderBottom={false}` over
// the input, see Input's `attachedAbove`): it fires at submit, and the prompt it is asking about
// is still sitting in the input underneath.
export function Confirm({ spec, selectedIndex }: { spec: ConfirmSpec; selectedIndex: number }) {
  return (
    <Box
      borderStyle={glyphs.border}
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
          {[
            `↑↓ or 1-${spec.options.length} navigate`,
            ...(spec.accept ? [`y/n jump (y = ${spec.accept})`] : []),
            'enter select',
            'esc/ctrl-c abort',
          ].join('  ·  ')}
        </Text>
      </Box>
    </Box>
  );
}
