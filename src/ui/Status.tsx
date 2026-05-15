import React from 'react';
import { Box, Text } from 'ink';

export function Status({
  model,
  turns,
  status,
  elapsed,
}: {
  model: string;
  turns: number;
  status: string;
  elapsed: number | null;
}) {
  const busy = elapsed !== null;
  const timer = busy ? ` · ${elapsed}s` : '';
  const keys = busy
    ? 'ctrl-c abort'
    : 'enter submit · \\ + enter newline · ctrl-c exit';

  return (
    <Box>
      <Text dimColor>
        {`${model} · turn ${turns} · ${status}${timer} · ${keys}`}
      </Text>
    </Box>
  );
}
