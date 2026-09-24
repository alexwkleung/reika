// Atomic terminal frames (#345).
//
// Ink paints a frame as `eraseLines(N) + output`, and when a message commits to <Static> it is
// three separate writes: erase the live region, write the static rows, redraw the live region.
// The terminal is free to paint between any two of those — or in the middle of one, since the
// pty hands a 10KB frame over in a few reads. Normally the gap is too short to see. Under memory
// pressure it isn't: this process is swapped or descheduled between writes (a 27B model on a
// 16GB machine is the usual cause), the terminal paints the erased state, and the UI flickers.
//
// Two things fix that at the writer, without touching Ink:
//
// 1. Every write inside one tick is coalesced into a single `stream.write`. Ink issues all of
//    a frame's writes synchronously in `onRender`, so the microtask boundary is the frame edge.
// 2. The coalesced write is wrapped in DEC private mode 2026 (synchronized output): the terminal
//    buffers everything between BSU and ESU and paints once. iTerm2, kitty, WezTerm, Ghostty,
//    Alacritty, foot, Windows Terminal, VS Code and tmux ≥ 3.3 honor it; a terminal that doesn't
//    ignores the two unknown sequences, which is the old behavior exactly.
//
// Writes are only queued for a real TTY; a pipe (tests, CI) gets the stream back untouched.
// `REIKA_SYNC_OUTPUT=0` is the kill switch for a terminal that misbehaves on mode 2026.

// Ink gives every code point its own grid cell, so `⏺︎` (U+23FA + VS15) spends two cells on a
// glyph the terminal draws in one, and a bordered row comes up a column short (#450). Components
// write a bare `⏺` — one cell, no phantom — and the selector goes back on here, after Ink has laid
// the row out, so the terminal still picks text presentation over the colored emoji disc (#494).
const BARE_RECORD_GLYPH = /\u23FA(?![\uFE0E\uFE0F])/g;

export function restoreTextPresentation(text: string): string {
  return text.replace(BARE_RECORD_GLYPH, '\u23FA\uFE0E');
}

export const BEGIN_SYNC = '\x1b[?2026h';
export const END_SYNC = '\x1b[?2026l';

type Chunk = string | Uint8Array;

export type FrameWriter = {
  write: (chunk: Chunk) => boolean;
  // Drain the pending frame now. Idempotent; a no-op when nothing is queued.
  flush: () => void;
  // Flush, then pass every later write straight through. For the process `exit` event, where
  // no further tick will come to run a queued flush — anything written after this point (the
  // focus-report reset, Ink's final frame) must reach the terminal synchronously.
  close: () => void;
};

export function createFrameWriter(target: { write: (chunk: Chunk) => boolean }): FrameWriter {
  let pending: string[] = [];
  let scheduled = false;
  let closed = false;

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const frame = pending.join('');
    pending = [];
    target.write(BEGIN_SYNC + restoreTextPresentation(frame) + END_SYNC);
  };

  return {
    write(chunk) {
      if (closed) return target.write(presentable(chunk));
      pending.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
      return true;
    },
    flush,
    close() {
      flush();
      closed = true;
    },
  };
}

function presentable(chunk: Chunk): Chunk {
  return typeof chunk === 'string' ? restoreTextPresentation(chunk) : chunk;
}

export function syncedOutputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REIKA_SYNC_OUTPUT !== '0';
}

// The stream Ink renders to. Everything but `write` — `columns`, `rows`, `isTTY`, the resize
// listeners — is the real stream's, so the components that size themselves off it see the same
// values whichever handle they hold.
export function createSyncedStdout(
  target: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.WriteStream {
  if (!target.isTTY) return target;
  // The kill switch drops the frame batching, not the presentation fix: without it the dialog
  // marker would be a bare `⏺` some terminals draw as an emoji.
  let write: (chunk: Chunk) => boolean;
  if (syncedOutputEnabled(env)) {
    const writer = createFrameWriter(target);
    process.once('exit', writer.close);
    write = writer.write;
  } else {
    write = chunk => target.write(presentable(chunk));
  }
  return new Proxy(target, {
    get(stream, prop) {
      if (prop === 'write') return write;
      const value = Reflect.get(stream, prop);
      return typeof value === 'function' ? value.bind(stream) : value;
    },
  });
}
