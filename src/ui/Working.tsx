import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

// Lighter braille "dots" spinner — its dot-mass sits nearer the text's x-height,
// so it reads as vertically aligned with the label (the fuller circular braille
// glyphs span the whole cell and look like they float above/below the text).
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Working({ label = 'Working' }: { label?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Box marginTop={1}>
      <Text color={theme.accent}>{FRAMES[frame]}</Text>
      <Text color={theme.muted}>{` ${label}…`}</Text>
    </Box>
  );
}
