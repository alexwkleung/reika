import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { displayCwd } from './scrub.js';

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
