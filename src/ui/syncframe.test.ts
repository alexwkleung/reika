import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  BEGIN_SYNC,
  END_SYNC,
  createFrameWriter,
  createSyncedStdout,
  restoreTextPresentation,
  syncedOutputEnabled,
} from './syncframe.js';

const tick = (): Promise<void> => new Promise(r => queueMicrotask(r));

function sink() {
  const writes: string[] = [];
  return { writes, write: vi.fn((c: string | Uint8Array) => (writes.push(String(c)), true)) };
}

describe('createFrameWriter', () => {
  it('coalesces every write in a tick into one synchronized frame', async () => {
    const out = sink();
    const w = createFrameWriter(out);
    // Ink's <Static> commit: erase the live region, write the static rows, redraw the live region.
    w.write('\x1b[2K\x1b[1A');
    w.write('committed row\n');
    w.write('live region\n');
    expect(out.writes).toEqual([]);
    await tick();
    expect(out.writes).toEqual([
      BEGIN_SYNC + '\x1b[2K\x1b[1Acommitted row\nlive region\n' + END_SYNC,
    ]);
  });

  it('keeps frames from different ticks separate', async () => {
    const out = sink();
    const w = createFrameWriter(out);
    w.write('a');
    await tick();
    w.write('b');
    await tick();
    expect(out.writes).toEqual([BEGIN_SYNC + 'a' + END_SYNC, BEGIN_SYNC + 'b' + END_SYNC]);
  });

  it('accepts bytes as well as strings', async () => {
    const out = sink();
    const w = createFrameWriter(out);
    w.write(Buffer.from('bytes'));
    await tick();
    expect(out.writes).toEqual([BEGIN_SYNC + 'bytes' + END_SYNC]);
  });

  it('flush is synchronous and idempotent', async () => {
    const out = sink();
    const w = createFrameWriter(out);
    w.write('a');
    w.flush();
    w.flush();
    expect(out.writes).toEqual([BEGIN_SYNC + 'a' + END_SYNC]);
    // The microtask the write scheduled finds nothing queued and writes nothing.
    await tick();
    expect(out.writes).toHaveLength(1);
  });

  it('close drains the frame and passes later writes straight through', () => {
    const out = sink();
    const w = createFrameWriter(out);
    w.write('last frame');
    w.close();
    // What the process `exit` handlers write after us (the focus-report reset) must land
    // without a tick, and unwrapped — there is no frame left to synchronize.
    w.write('\x1b[?1004l');
    expect(out.writes).toEqual([BEGIN_SYNC + 'last frame' + END_SYNC, '\x1b[?1004l']);
  });
});

describe('restoreTextPresentation', () => {
  it('puts VS15 back on a bare record glyph', () => {
    expect(restoreTextPresentation('│ \u23FA Bash  npm test │')).toBe(
      '│ \u23FA\uFE0E Bash  npm test │',
    );
  });

  // The scrollback marker already carries VS15, and an explicit VS16 is someone asking for the
  // emoji — neither gets a second selector.
  it('leaves an existing variation selector alone', () => {
    expect(restoreTextPresentation('\u23FA\uFE0E a \u23FA\uFE0F b')).toBe(
      '\u23FA\uFE0E a \u23FA\uFE0F b',
    );
  });

  it('is applied to the synchronized frame and to writes after close', () => {
    const out = sink();
    const w = createFrameWriter(out);
    w.write('\u23FA');
    w.close();
    w.write('\u23FA');
    expect(out.writes).toEqual([BEGIN_SYNC + '\u23FA\uFE0E' + END_SYNC, '\u23FA\uFE0E']);
  });
});

describe('createSyncedStdout', () => {
  function fakeTty(isTTY = true) {
    const stream = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      columns: number;
      rows: number;
      writes: string[];
      write: (c: string | Uint8Array) => boolean;
    };
    stream.isTTY = isTTY;
    stream.columns = 120;
    stream.rows = 40;
    stream.writes = [];
    stream.write = c => (stream.writes.push(String(c)), true);
    return stream;
  }

  it('returns the stream itself off a TTY', () => {
    const pipe = fakeTty(false);
    expect(createSyncedStdout(pipe as never, {})).toBe(pipe);
    expect(syncedOutputEnabled({})).toBe(true);
    expect(syncedOutputEnabled({ REIKA_SYNC_OUTPUT: '0' })).toBe(false);
  });

  // The kill switch is for terminals that misbehave on mode 2026; the dialog marker must not
  // regress to an emoji disc on them.
  it('switched off, writes through unbatched but still restores text presentation', () => {
    const tty = fakeTty();
    const plain = createSyncedStdout(tty as never, { REIKA_SYNC_OUTPUT: '0' });
    plain.write('\u23FA Bash');
    expect(tty.writes).toEqual(['\u23FA\uFE0E Bash']);
  });

  it('wraps writes and leaves size, TTY-ness and resize events on the real stream', async () => {
    const tty = fakeTty();
    const synced = createSyncedStdout(tty as never, {});
    expect(synced).not.toBe(tty);
    expect(synced.isTTY).toBe(true);
    expect(synced.columns).toBe(120);
    expect(synced.rows).toBe(40);
    tty.columns = 80;
    expect(synced.columns).toBe(80);

    const onResize = vi.fn();
    synced.on('resize', onResize);
    tty.emit('resize');
    expect(onResize).toHaveBeenCalledTimes(1);
    synced.off('resize', onResize);
    tty.emit('resize');
    expect(onResize).toHaveBeenCalledTimes(1);

    synced.write('frame');
    expect(tty.writes).toEqual([]);
    await tick();
    expect(tty.writes).toEqual([BEGIN_SYNC + 'frame' + END_SYNC]);
  });
});
