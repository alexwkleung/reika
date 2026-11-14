import { Box, Text } from 'ink';
import { type ConfirmSpec } from './dialogspecs.js';
import { IMPLEMENT_MODES, type ImplementMode } from '../agent/turncommands.js';
import { glyphs } from './glyphs.js';
import { theme } from './theme.js';

const IMPLEMENT_MODE_LABELS: Record<ImplementMode, string> = {
  agent: 'Agent — full tool set',
  minimal: 'Minimal — shell only, no repo map or AGENTS.md',
  grind: 'Grind — fixed procedure, proves the change by running checks',
};

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
