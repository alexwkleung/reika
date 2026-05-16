import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

export function Input({
  value,
  onChange,
  onSubmit,
  disabled,
  spinning,
  mode,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  spinning: boolean;
  mode: 'agent' | 'shell';
  placeholder?: string;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [spinning]);

  const handle = (v: string) => {
    if (disabled) return;
    if (v.endsWith('\\')) {
      onChange(v.slice(0, -1) + '\n');
      return;
    }
    onSubmit(v);
  };

  const idlePrompt = mode === 'shell' ? '$ ' : '> ';
  const prompt = spinning ? `${FRAMES[frame]}  ` : disabled ? '…  ' : idlePrompt;

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>{prompt}</Text>
      <TextInput
        value={value}
        onChange={disabled ? () => {} : onChange}
        onSubmit={handle}
        focus={!disabled}
        placeholder={placeholder}
      />
    </Box>
  );
}
