import React from 'react';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';

export function Header({ model, cwd }: { model: string; cwd: string }) {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text bold>Reika</Text>
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
