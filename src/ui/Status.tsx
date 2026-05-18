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
  autoApprove,
  modeTag,
}: {
  model: string;
  turns: number;
  status: string;
  elapsed: number | null;
  usage: Usage;
  autoApprove?: boolean;
  modeTag?: string;
}) {
  const busy = elapsed !== null;
  const timer = busy ? ` · ${elapsed}s` : '';
  const keys = busy
    ? 'ctrl-c to abort'
    : 'enter to submit · shift+enter for newline · ctrl-c to exit';
  const tokens =
    usage.promptTokens > 0 || usage.completionTokens > 0
      ? ` · ${kFormat(usage.promptTokens)}↑ ${kFormat(usage.completionTokens)}↓`
      : '';

  return (
    <Box>
      {modeTag ? (
        <>
          <Text color={theme.tool}>{modeTag}</Text>
          <Text color={theme.muted}>{' · '}</Text>
        </>
      ) : null}
      {autoApprove ? (
        <>
          <Text color={theme.warning}>auto approve on</Text>
          <Text color={theme.muted}>{' · '}</Text>
        </>
      ) : null}
      <Text
        color={theme.muted}
      >{`${model} · turn ${turns} · ${status}${timer}${tokens} · ${keys}`}</Text>
    </Box>
  );
}

export function kFormat(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  if (n < 10_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n < 1_000_000_000) return Math.round(n / 1_000_000) + 'M';
  if (n < 10_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  return Math.round(n / 1_000_000_000) + 'B';
}
