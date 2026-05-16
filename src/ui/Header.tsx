import React from 'react';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export function Header({ model, cwd }: { model: string; cwd: string }) {
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        Reika
      </Text>
      <Text dimColor>{`  ·  ${model}  ·  ${displayCwd(cwd)}`}</Text>
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
