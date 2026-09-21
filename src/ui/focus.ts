import { useEffect, useState } from 'react';
import { useStdin, useStdout } from 'ink';

// Terminal focus tracking (issue #352). We draw our own cursor (Input.tsx), so the terminal's
// own "stop blinking when the window loses focus" never reaches it — the block kept blinking
// in every unfocused window. DECSET 1004 asks the terminal to report focus changes as
// `ESC [ I` (in) / `ESC [ O` (out); we read those off Ink's raw input emitter.
export const FOCUS_REPORT_ON = '\x1b[?1004h';
export const FOCUS_REPORT_OFF = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

export function parseFocusEvent(chunk: string): 'in' | 'out' | null {
  return chunk === FOCUS_IN ? 'in' : chunk === FOCUS_OUT ? 'out' : null;
}

// Ink has no name for these sequences, so `useInput` hands them over as the raw text with the
// leading ESC stripped — `[I` / `[O`, no key flags — and a text field would insert them as typed
// characters. Handlers check this first and drop the keypress.
export function isFocusKeypress(input: string): boolean {
  return input === '[I' || input === '[O';
}

// True until the terminal says otherwise: a terminal that doesn't report focus (or a tmux
// without `focus-events on`) never sends either sequence, and "focused" is the behaviour it
// had before. Reporting is switched on only for a real TTY — under a pipe or the test
// renderer there is no window to lose focus — and switched off again on unmount, plus on
// process exit as a safety net: left on, the user's shell gets `^[[I` typed at it on every
// window switch.
export function useTerminalFocus(): boolean {
  const [focused, setFocused] = useState(true);
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!internal_eventEmitter) return;
    const onInput = (chunk: string | Buffer): void => {
      const event = parseFocusEvent(typeof chunk === 'string' ? chunk : chunk.toString());
      if (event) setFocused(event === 'in');
    };
    internal_eventEmitter.on('input', onInput);
    if (!stdout.isTTY) {
      return () => {
        internal_eventEmitter.removeListener('input', onInput);
      };
    }
    const off = (): void => {
      stdout.write(FOCUS_REPORT_OFF);
    };
    stdout.write(FOCUS_REPORT_ON);
    process.once('exit', off);
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
      process.removeListener('exit', off);
      off();
    };
  }, [internal_eventEmitter, stdout]);

  return focused;
}
