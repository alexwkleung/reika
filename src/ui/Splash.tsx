import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { displayCwd } from './scrub.js';

const LOGO = [
  '██████╗ ███████╗██╗██╗  ██╗ █████╗ ',
  '██╔══██╗██╔════╝██║██║ ██╔╝██╔══██╗',
  '██████╔╝█████╗  ██║█████╔╝ ███████║',
  '██╔══██╗██╔══╝  ██║██╔═██╗ ██╔══██║',
  '██║  ██║███████╗██║██║  ██╗██║  ██║',
  '╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
];

// Per-row gradient for the wordmark: a single-hue orchid ramp, pale bloom fading
// to deep plum — reika (レイカ) means "beautiful flower". Staying monochrome (no
// cool blue) keeps it off the blue→magenta "AI CLI" house palette. Six stops, one
// per LOGO row.
const LOGO_GRADIENT = ['#edc4e8', '#dea9d7', '#cf8ec6', '#bf73b5', '#b058a4', '#a13d93'];

export function Splash({
  model,
  cwd,
  version,
  subagent,
}: {
  model: string;
  cwd: string;
  version: string;
  subagent?: string;
}) {
  const labelWidth = subagent ? 'subagent:  '.length : 'model:    '.length;
  const tagline = `coding agent for local models · v${version}`;
  // Lead the tagline with a flower (❀) — reika (レイカ) means "beautiful flower".
  // The mark occupies "❀ " = 2 columns, so the rule spans the flower + tagline.
  const rule = '─'.repeat(tagline.length + 2);
  return (
    <Box flexDirection="column" paddingY={1}>
      {LOGO.map((line, i) => (
        <Text key={i} color={LOGO_GRADIENT[i] ?? theme.accent}>
          {line}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.accent}>❀ </Text>
          <Text color={theme.muted}>{tagline}</Text>
        </Box>
        <Text color={theme.muted} dimColor>
          {rule}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.muted}>{padLabel('model:', labelWidth)}</Text>
          <Text>{model}</Text>
        </Box>
        {subagent ? (
          <Box>
            <Text color={theme.muted}>{padLabel('subagent:', labelWidth)}</Text>
            <Text>{subagent}</Text>
          </Box>
        ) : null}
        <Box>
          <Text color={theme.muted}>{padLabel('cwd:', labelWidth)}</Text>
          <Text>{displayCwd(cwd)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>/help for commands · @ to attach files</Text>
      </Box>
    </Box>
  );
}

function padLabel(label: string, width: number): string {
  return label + ' '.repeat(Math.max(1, width - label.length));
}
