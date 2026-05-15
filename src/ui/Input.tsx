import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export function Input({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const handle = (v: string) => {
    if (disabled) return;
    setValue('');
    onSubmit(v);
  };
  return (
    <Box marginTop={1}>
      <Text>{disabled ? '… ' : '> '}</Text>
      <TextInput
        value={value}
        onChange={disabled ? () => {} : setValue}
        onSubmit={handle}
        focus={!disabled}
      />
    </Box>
  );
}
