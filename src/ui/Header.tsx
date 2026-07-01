import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export function Header({ model, cwd }: { model: string; cwd: string }) {
  return (
    <Box paddingX={1} paddingTop={1}>
      <Text bold color={theme.accent}>
        Reika
      </Text>
      <Text color={theme.muted}>{`  ·  ${model}  ·  ${displayCwd(cwd)}`}</Text>
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
