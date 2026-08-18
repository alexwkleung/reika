import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { displayCwd } from './scrub.js';
import { contentWidth } from './layout.js';

export function Header({ model, cwd }: { model: string; cwd: string }) {
  return (
    // Explicit width: this is a row of two Texts inside <Static>, where Ink otherwise lays each
    // child out at its intrinsic width and lets the row overflow — a long cwd then runs off the
    // edge and the terminal breaks it mid-path. See layout.ts.
    <Box paddingX={1} paddingTop={1} width={contentWidth()}>
      <Text bold color={theme.accent}>
        Reika
      </Text>
      <Text color={theme.muted}>{`  ·  ${model}  ·  ${displayCwd(cwd)}`}</Text>
    </Box>
  );
}
