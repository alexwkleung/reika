import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { theme } from './theme.js';
import type { Mode } from './commands.js';

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
  suggesting,
  history,
  attachedAbove,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  canSubmit: boolean;
  mode: Mode;
  placeholder?: string;
  // True while an approval popup is shown directly above: the popup omits its
  // bottom border and we omit our top border + top margin, so the two boxes
  // merge into one continuous frame (the prompt reads as part of the input
  // region rather than a card floating above it).
  attachedAbove?: boolean;
  // True while the completion/approval overlay owns Up/Down (App navigates it);
  // we leave the arrows alone then instead of moving the cursor between lines.
  suggesting: boolean;
  // Past submissions, oldest→newest, recalled by Up on the first line / Down on
  // the last line (shell-style history).
  history: string[];
}) {
  const [cursor, setCursor] = useState(value.length);
  const [blinkOn, setBlinkOn] = useState(true);
  const lastValueRef = useRef(value);

  // Blink the drawn cursor (~530ms, the classic terminal rate). We draw our own
  // block via inverse video rather than the real terminal cursor, so the
  // terminal's blink setting can't reach it — we toggle visibility ourselves.
  // Re-running on value/cursor change snaps it solid and restarts the timer, so
  // the block is always visible the instant you type or move.
  useEffect(() => {
    if (disabled) return;
    setBlinkOn(true);
    const id = setInterval(() => setBlinkOn(on => !on), 530);
    return () => clearInterval(id);
  }, [value, cursor, disabled]);

  // Kept current each render so the raw-stdin listener (which closes over them
  // once) always sees the latest value/cursor without re-subscribing.
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Remembered column for vertical (Up/Down) motion, so walking through a short
  // line and back doesn't snap the cursor to that line's length. Null means
  // "recompute from the current column"; any non-vertical action clears it.
  const goalColRef = useRef<number | null>(null);

  // History recall position: null means "showing the live draft", a number
  // indexes into `history`. While walking history we keep the draft so coming
  // back down past the newest entry restores what was being typed.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef('');

  // Home/End (incl. Cmd+Arrow remapped to \e[H / \e[F) bypass `useInput`, which
  // discards them. Subscribe to Ink's raw input emitter and map them to line
  // start/end ourselves. Ink still also dispatches them through useInput as an
  // empty keypress, which our handler ignores — no double-handling.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    if (disabled || !internal_eventEmitter) return;
    const onInput = (chunk: string | Buffer): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      if (HOME_SEQS.has(s)) {
        goalColRef.current = null;
        setCursor(lineStart(valueRef.current, cursorRef.current));
      } else if (END_SEQS.has(s)) {
        goalColRef.current = null;
        setCursor(lineEnd(valueRef.current, cursorRef.current));
      }
    };
    internal_eventEmitter.on('input', onInput);
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
    };
  }, [disabled, internal_eventEmitter]);

  // External value change (e.g., suggestion accept, submit clear) — snap cursor to
  // end. Our own recall calls update() (which syncs lastValueRef) first, so this
  // only fires for App-driven changes, where leaving history navigation is right.
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setCursor(value.length);
      setHistoryIndex(null);
    }
  }, [value]);

  const update = (next: string, nextCursor: number): void => {
    lastValueRef.current = next;
    setCursor(nextCursor);
    onChange(next);
  };

  // Replace the buffer with a recalled entry and park the cursor at its end.
  const recall = (index: number | null, text: string): void => {
    goalColRef.current = null;
    setHistoryIndex(index);
    update(text, text.length);
  };

  // Up on the first line: step toward older entries. The first step stashes the
  // current draft so Down can bring it back. No-op once at the oldest entry.
  const recallPrev = (): void => {
    if (history.length === 0) return;
    if (historyIndex === null) {
      draftRef.current = value;
      recall(history.length - 1, history[history.length - 1]);
    } else if (historyIndex > 0) {
      recall(historyIndex - 1, history[historyIndex - 1]);
    }
  };

  // Down on the last line: step toward newer entries; stepping past the newest
  // restores the stashed draft (usually empty). No-op when not walking history.
  const recallNext = (): void => {
    if (historyIndex === null) return;
    if (historyIndex < history.length - 1) {
      recall(historyIndex + 1, history[historyIndex + 1]);
    } else {
      recall(null, draftRef.current);
    }
  };

  useInput(
    (input, key) => {
      // Any key other than a bare Up/Down resets the remembered goal column.
      if (!((key.upArrow || key.downArrow) && !key.ctrl && !key.meta)) {
        goalColRef.current = null;
      }

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

      // Newline insertion. Both Shift+Enter (when the terminal is configured to
      // emit it) and Ctrl+J arrive as a bare line feed — Ink names this 'enter'
      // (input '\n', key.return false), distinct from Return's carriage return
      // (\r). Insert a newline rather than submitting. A lone '\n' only; pasted
      // text with embedded newlines is multi-char and falls to insertion below.
      if (input === '\n') {
        update(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1);
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

      // Up/Down walk between lines of a multi-line buffer, holding the column.
      // While a completion/approval overlay is open it owns the arrows (App
      // navigates the list), so we stay out of the way. Ctrl/Meta+Up/Down aren't
      // ours either. At the buffer edge — Up on the first line, Down on the last
      // — there's no line to move to, so we recall message history instead.
      if ((key.upArrow || key.downArrow) && !suggesting && !key.ctrl && !key.meta) {
        const ls = lineStart(value, cursor);
        const le = lineEnd(value, cursor);
        if (key.upArrow && ls === 0) {
          recallPrev();
          return;
        }
        if (key.downArrow && le === value.length) {
          recallNext();
          return;
        }
        const col = goalColRef.current ?? cursor - ls;
        goalColRef.current = col;
        if (key.upArrow) {
          const prevStart = lineStart(value, ls - 1);
          setCursor(prevStart + Math.min(col, ls - 1 - prevStart));
        } else {
          const nextStart = le + 1;
          setCursor(nextStart + Math.min(col, lineEnd(value, nextStart) - nextStart));
        }
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

      // Plain character insertion. A paste arrives here too: Ink hands the whole
      // clipboard over as one multi-char `input` (it has no bracketed-paste
      // support), and terminals encode the line breaks in a paste as carriage
      // returns. Normalize before inserting — raw \r would carriage-return the
      // rendered <Text> to column 0 and shred the box; CRs become \n so a
      // multi-line paste lands as a clean multi-line buffer (same shape as
      // Shift+Enter), which lineStart/lineEnd and the renderer already handle.
      if (input && !key.meta && !key.upArrow && !key.downArrow && !key.tab && !key.escape) {
        const text = normalizePaste(input);
        if (!text) return;
        const next = value.slice(0, cursor) + text + value.slice(cursor);
        update(next, cursor + text.length);
      }
    },
    { isActive: !disabled },
  );

  const idlePrompt = mode === 'shell' ? '$ ' : mode === 'chat' ? '? ' : '> ';
  const promptText = disabled ? '…  ' : idlePrompt;
  const showPlaceholder = !value && !!placeholder && !disabled;

  return (
    <Box
      borderStyle="round"
      borderTop={!attachedAbove}
      paddingX={1}
      marginTop={attachedAbove ? 0 : 1}
    >
      <Text>{promptText}</Text>
      {showPlaceholder ? (
        <Box>
          {blinkOn ? (
            <>
              <Text>{`${INVERSE_ON}${placeholder[0]}${INVERSE_OFF}`}</Text>
              <Text color={theme.muted}>{placeholder.slice(1)}</Text>
            </>
          ) : (
            <Text color={theme.muted}>{placeholder}</Text>
          )}
        </Box>
      ) : (
        <Text>{renderWithCursor(value, cursor, !disabled, blinkOn)}</Text>
      )}
    </Box>
  );
}

// Clean up typed/pasted text before it enters the buffer. Terminals send a
// paste's internal newlines as \r (or \r\n) and may, on some configs, wrap the
// payload in bracketed-paste markers; left in the buffer these corrupt the
// rendered input box. Fold every line ending to \n, drop the markers, and strip
// other C0 control chars (keeping \t and \n) so the buffer stays printable.
function normalizePaste(input: string): string {
  return input
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste start/end markers
    .replace(/\r\n?/g, '\n') // CRLF or lone CR -> LF
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); // other controls (keep \t, \n)
}

function renderWithCursor(
  value: string,
  cursor: number,
  focused: boolean,
  blinkOn: boolean,
): string {
  if (!focused || !blinkOn) return value;
  const before = value.slice(0, cursor);
  const ch = value[cursor];
  // At a line break or the end of the buffer there's no glyph to invert, so the
  // block would land on a zero-width newline and vanish. Draw it over a space
  // instead, and re-emit the newline after it so the line break is preserved.
  const at = ch === undefined || ch === '\n' ? ' ' : ch;
  const after = ch === '\n' ? '\n' + value.slice(cursor + 1) : value.slice(cursor + 1);
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
