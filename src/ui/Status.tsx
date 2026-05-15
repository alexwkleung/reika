import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Status({
  model,
  turns,
  status,
  elapsed,
  hint,
}: {
  model: string;
  turns: number;
  status: string;
  elapsed: number | null;
  hint?: string | null;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (elapsed === null) return;
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [elapsed === null]);

  const spinner = elapsed !== null ? `${FRAMES[frame]} ` : '';
  const timer = elapsed !== null ? ` · ${elapsed}s` : '';
  const hintText = hint ? ` · ${hint}` : '';

  return (
    <Box marginTop={1}>
      <Text dimColor>{`${spinner}${model} · turn ${turns} · ${status}${timer}${hintText}`}</Text>
    </Box>
  );
}
