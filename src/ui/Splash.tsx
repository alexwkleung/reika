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

export function Splash({ model, cwd, version }: { model: string; cwd: string; version: string }) {
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
        <Text dimColor>{`minimal coding agent · v${version}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{'model:  '}</Text>
          <Text>{model}</Text>
        </Box>
        <Box>
          <Text dimColor>{'cwd:    '}</Text>
          <Text>{displayCwd(cwd)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>/help for commands · @ to attach files</Text>
      </Box>
    </Box>
  );
}

function displayCwd(cwd: string): string {
  const home = homedir();
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}
