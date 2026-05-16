import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const INVERSE_ON = '\x1b[7m';
const INVERSE_OFF = '\x1b[27m';

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
  const [cursor, setCursor] = useState(value.length);
  const [frame, setFrame] = useState(0);
  const lastValueRef = useRef(value);

  // External value change (e.g., suggestion accept, submit clear) — snap cursor to end.
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setCursor(value.length);
    }
  }, [value]);

  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [spinning]);

  const update = (next: string, nextCursor: number): void => {
    lastValueRef.current = next;
    setCursor(nextCursor);
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.return) {
        if (value.endsWith('\\')) {
          update(value.slice(0, -1) + '\n', cursor);
          return;
        }
        onSubmit(value);
        return;
      }

      // macOS terminals usually send Backspace as DEL (\x7f), which some Ink
      // configurations route to key.delete rather than key.backspace. Treat both
      // as backward delete so it works consistently across platforms.
      if (key.backspace || key.delete) {
        if (key.meta || key.ctrl) {
          const start = wordBackward(value, cursor);
          update(value.slice(0, start) + value.slice(cursor), start);
        } else if (cursor > 0) {
          update(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        }
        return;
      }

      if (key.leftArrow) {
        if (key.meta || key.ctrl) setCursor(wordBackward(value, cursor));
        else setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) setCursor(wordForward(value, cursor));
        else setCursor(Math.min(value.length, cursor + 1));
        return;
      }

      if (key.ctrl) {
        if (input === 'a') setCursor(0);
        else if (input === 'e') setCursor(value.length);
        else if (input === 'u') update(value.slice(cursor), 0);
        else if (input === 'k') update(value.slice(0, cursor), cursor);
        else if (input === 'w') {
          const start = wordBackward(value, cursor);
          update(value.slice(0, start) + value.slice(cursor), start);
        }
        return;
      }

      // Plain character insertion (multi-char input from paste is fine).
      if (input && !key.meta && !key.upArrow && !key.downArrow && !key.tab && !key.escape) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        update(next, cursor + input.length);
      }
    },
    { isActive: !disabled },
  );

  const idlePrompt = mode === 'shell' ? '$ ' : '> ';
  const prompt = spinning ? `${FRAMES[frame]}  ` : disabled ? '…  ' : idlePrompt;
  const showPlaceholder = !value && !!placeholder && !disabled;

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>{prompt}</Text>
      {showPlaceholder ? (
        <Box>
          <Text>{`${INVERSE_ON} ${INVERSE_OFF}`}</Text>
          <Text dimColor>{placeholder}</Text>
        </Box>
      ) : (
        <Text>{renderWithCursor(value, cursor, !disabled)}</Text>
      )}
    </Box>
  );
}

function renderWithCursor(value: string, cursor: number, focused: boolean): string {
  if (!focused) return value;
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return before + INVERSE_ON + at + INVERSE_OFF + after;
}

function wordForward(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && /\s/.test(value[i])) i++;
  while (i < value.length && /\S/.test(value[i])) i++;
  return i;
}

function wordBackward(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1])) i--;
  while (i > 0 && /\S/.test(value[i - 1])) i--;
  return i;
}
