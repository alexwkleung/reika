import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { theme } from './theme.js';

const LOGO = [
  '██████╗ ███████╗██╗██╗  ██╗ █████╗ ',
  '██╔══██╗██╔════╝██║██║ ██╔╝██╔══██╗',
  '██████╔╝█████╗  ██║█████╔╝ ███████║',
  '██╔══██╗██╔══╝  ██║██╔═██╗ ██╔══██║',
  '██║  ██║███████╗██║██║  ██╗██║  ██║',
  '╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
];

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
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      {LOGO.map((line, i) => (
        <Text key={i} color={theme.accent}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>{`minimal coding agent · v${version}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
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

function displayCwd(cwd: string): string {
  const home = homedir();
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}
