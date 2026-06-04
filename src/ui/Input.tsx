import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { theme } from './theme.js';

const INVERSE_ON = '\x1b[7m';
const INVERSE_OFF = '\x1b[27m';

// Home/End escape sequences. Terminals (e.g. iTerm2 with Cmd+Left/Right remapped
// to send \e[H / \e[F) emit these for line-start/end. Ink's keypress parser
// recognizes them but `useInput` doesn't surface Home/End, so we read the raw
// chunk off Ink's input emitter instead (see the useEffect below).
const HOME_SEQS = new Set(['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']);
const END_SEQS = new Set(['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']);

export function Input({
  value,
  onChange,
  onSubmit,
  disabled,
  canSubmit,
  mode,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  canSubmit: boolean;
  mode: 'agent' | 'shell' | 'chat';
  placeholder?: string;
}) {
  const [cursor, setCursor] = useState(value.length);
  const lastValueRef = useRef(value);

  // Kept current each render so the raw-stdin listener (which closes over them
  // once) always sees the latest value/cursor without re-subscribing.
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Home/End (incl. Cmd+Arrow remapped to \e[H / \e[F) bypass `useInput`, which
  // discards them. Subscribe to Ink's raw input emitter and map them to line
  // start/end ourselves. Ink still also dispatches them through useInput as an
  // empty keypress, which our handler ignores — no double-handling.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    const onInput = (chunk: string | Buffer): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      if (HOME_SEQS.has(s)) setCursor(lineStart(valueRef.current, cursorRef.current));
      else if (END_SEQS.has(s)) setCursor(lineEnd(valueRef.current, cursorRef.current));
    };
    internal_eventEmitter.on('input', onInput);
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
    };
  }, [disabled, internal_eventEmitter]);

  // External value change (e.g., suggestion accept, submit clear) — snap cursor to end.
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setCursor(value.length);
    }
  }, [value]);

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
        // While a turn is streaming the user can keep typing/composing, but the
        // message can't be sent until the turn finishes or is aborted.
        if (!canSubmit) return;
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

      // Option/Alt+Arrow jumps by word; Ctrl+Arrow jumps to line start/end.
      // (Cmd+Arrow can't be bound — macOS terminals never forward the ⌘ key.)
      if (key.leftArrow) {
        if (key.meta) setCursor(wordBackward(value, cursor));
        else if (key.ctrl) setCursor(lineStart(value, cursor));
        else setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        if (key.meta) setCursor(wordForward(value, cursor));
        else if (key.ctrl) setCursor(lineEnd(value, cursor));
        else setCursor(Math.min(value.length, cursor + 1));
        return;
      }

      // Many macOS terminals emit readline word motions for Option+Arrow:
      // ESC-b / ESC-f (Ink reports these as meta + 'b'/'f'), not a modified
      // arrow sequence. Handle them so Option+Arrow word-jumps without Cmd.
      if (key.meta && (input === 'b' || input === 'f')) {
        setCursor(input === 'b' ? wordBackward(value, cursor) : wordForward(value, cursor));
        return;
      }

      if (key.ctrl) {
        if (input === 'a') setCursor(lineStart(value, cursor));
        else if (input === 'e') setCursor(lineEnd(value, cursor));
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

  const idlePrompt = mode === 'shell' ? '$ ' : mode === 'chat' ? '? ' : '> ';
  const promptText = disabled ? '…  ' : idlePrompt;
  const showPlaceholder = !value && !!placeholder && !disabled;

  return (
    <Box borderStyle="round" paddingX={1} marginTop={1}>
      <Text>{promptText}</Text>
      {showPlaceholder ? (
        <Box>
          <Text>{`${INVERSE_ON} ${INVERSE_OFF}`}</Text>
          <Text color={theme.muted}>{placeholder}</Text>
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

// Start/end of the current logical line (the buffer may span multiple lines
// via Shift+Enter or `\`-continuation), not the whole buffer.
function lineStart(value: string, cursor: number): number {
  const nl = value.lastIndexOf('\n', cursor - 1);
  return nl === -1 ? 0 : nl + 1;
}

function lineEnd(value: string, cursor: number): number {
  const nl = value.indexOf('\n', cursor);
  return nl === -1 ? value.length : nl;
}
