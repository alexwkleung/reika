import React from 'react';
import { Box, Text } from 'ink';
import type { Usage } from '../types.js';
import { theme } from './theme.js';

export function Status({
  model,
  turns,
  status,
  elapsed,
  usage,
}: {
  model: string;
  turns: number;
  status: string;
  elapsed: number | null;
  usage: Usage;
}) {
  const busy = elapsed !== null;
  const timer = busy ? ` · ${elapsed}s` : '';
  const keys = busy ? 'ctrl-c abort' : 'enter submit · \\ + enter newline · ctrl-c exit';
  const tokens =
    usage.promptTokens > 0 || usage.completionTokens > 0
      ? ` · ${kFormat(usage.promptTokens)}↑ ${kFormat(usage.completionTokens)}↓`
      : '';

  return (
    <Box>
      <Text
        color={theme.muted}
      >{`${model} · turn ${turns} · ${status}${timer}${tokens} · ${keys}`}</Text>
    </Box>
  );
}

function kFormat(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + 'k';
}
