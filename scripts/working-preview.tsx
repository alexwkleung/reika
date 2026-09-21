/** @jsxRuntime automatic */
// Live side-by-side of every `Working` indicator the app can show (#429). Run with
//   npx tsx scripts/working-preview.tsx
// and judge the sweep by eye in the real terminal; q / Esc / ctrl-c exits. The static swatch
// under each row is the same ramp frozen (resting base, then the band rim → tip → rim), so a
// sweep that is hard to see can be checked against its numbers without waiting for a pass.
import { Box, Text, render, useApp, useInput } from 'ink';
import { Working, lightness, shimmerBase, shimmerRamp } from '../src/ui/Working.js';
import { theme } from '../src/ui/theme.js';

// Every (label, accent) pair App.tsx renders, in the order it decides them.
const STATES: { name: string; label?: string; accent?: string }[] = [
  { name: 'default (agent turn)' },
  { name: 'typechecking', label: 'Typechecking', accent: theme.info },
  { name: 'loop recovery', label: 'Recovering from a loop', accent: theme.info },
  {
    name: 'spin hint',
    label: 'Thinking — may be looping (ctrl-c to abort)',
    accent: theme.warning,
  },
  { name: 'compaction note', label: 'Writing compaction note', accent: theme.info },
  { name: 'subagent', label: 'Subagent working', accent: theme.subagent },
  { name: 'clipboard image', label: 'Reading image from clipboard', accent: theme.info },
  { name: 'clipboard ocr', label: 'Extracting text', accent: theme.info },
  { name: 'pasted link', label: 'Fetching 1 pasted link', accent: theme.info },
];

function Row({ name, label, accent }: { name: string; label?: string; accent?: string }) {
  const a = accent ?? theme.accent;
  const base = shimmerBase(a);
  const ramp = shimmerRamp(a);
  const tip = ramp[Math.floor(ramp.length / 2)];
  const lBase = lightness(base);
  const lTip = lightness(tip);
  return (
    <Box flexDirection="column">
      <Working label={label} accent={a} />
      <Box paddingLeft={2}>
        <Text color={theme.muted}>{name.padEnd(22)}</Text>
        <Text color={base}>{'██'}</Text>
        {ramp.map((c, i) => (
          <Text key={i} color={c}>
            {'██'}
          </Text>
        ))}
        <Text color={theme.muted}>
          {`  base ${base} L*${lBase.toFixed(0)}  tip ${tip} L*${lTip.toFixed(0)}  ΔL* ${(lTip - lBase).toFixed(1)}`}
        </Text>
      </Box>
    </Box>
  );
}

function Preview() {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.secondary}>
        Working indicators — every state App.tsx can show. Swatch: resting base, then the band
        rim→tip→rim. q to quit.
      </Text>
      {STATES.map(s => (
        <Row key={s.name} {...s} />
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>{'  Worked for 12s'}</Text>
        <Text color={theme.muted}>
          {`   ← the finished line (theme.muted, L*${lightness(theme.muted).toFixed(0)}), for reference`}
        </Text>
      </Box>
    </Box>
  );
}

render(<Preview />);
