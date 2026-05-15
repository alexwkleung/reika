import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

export function Input({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!disabled) return;
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [disabled]);

  const handle = (v: string) => {
    if (disabled) return;
    if (v.endsWith('\\')) {
      setValue(v.slice(0, -1) + '\n');
      return;
    }
    setValue('');
    onSubmit(v);
  };

  const prompt = disabled ? `${FRAMES[frame]}  ` : '> ';

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>{prompt}</Text>
      <TextInput
        value={value}
        onChange={disabled ? () => {} : setValue}
        onSubmit={handle}
        focus={!disabled}
      />
    </Box>
  );
}
