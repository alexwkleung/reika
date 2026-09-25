import { describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { Input, clampToViewport } from './Input.js';
import { rememberPaste, type PastedText } from './pastes.js';

// Longer than the paste coalescing window, so a write lands as its own paste unless the test
// deliberately writes back-to-back inside one tick.
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 40));

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

// Drives Input the way App does, including parking large pastes behind a marker.
function Harness({
  onSubmit = () => {},
  withPasteStore = true,
}: {
  onSubmit?: (v: string) => void;
  withPasteStore?: boolean;
}) {
  const [value, setValue] = useState('');
  const [pastes, setPastes] = useState<PastedText[]>([]);
  const store = React.useRef<PastedText[]>([]);
  store.current = pastes;
  return (
    <Input
      value={value}
      onChange={setValue}
      onSubmit={v => {
        onSubmit(v);
        setValue('');
      }}
      onPasteText={
        withPasteStore
          ? text => {
              const next = rememberPaste(store.current, text);
              store.current = next.pastes;
              setPastes(next.pastes);
              return next.marker;
            }
          : undefined
      }
      disabled={false}
      mode="agent"
      suggesting={false}
      history={[]}
    />
  );
}

const bigPaste = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\r');

describe('large paste handling', () => {
  it('replaces a pasted wall of text with a marker', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick();

    stdin.write(bigPaste(400));
    await tick();

    const frame = plain(lastFrame());
    expect(frame).toContain('[Pasted text #1 +400 lines]');
    expect(frame).not.toContain('line 399');
  });

  it('joins the chunks a terminal splits a paste into, marker count and all', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick();

    // Same paste, delivered as three chunks with a boundary landing on a line break — the
    // split that used to submit mid-paste and leave the rest as a second buffer.
    stdin.write('line 0\rline 1');
    stdin.write('\r');
    stdin.write(bigPaste(30));
    await tick();

    const frame = plain(lastFrame());
    expect(frame).toContain('[Pasted text #1 +32 lines]');
    expect(frame).not.toContain('#2');
  });

  it('does not submit on a carriage return that is really a chunk boundary', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Harness onSubmit={onSubmit} />);
    await tick();

    stdin.write(bigPaste(20));
    stdin.write('\r');
    stdin.write(bigPaste(20));
    await tick();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still submits on Return once the paste has settled', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Harness onSubmit={onSubmit} />);
    await tick();

    stdin.write(bigPaste(20));
    await tick();
    stdin.write('\r');
    await tick();

    expect(onSubmit).toHaveBeenCalledWith('[Pasted text #1 +20 lines]');
  });

  it('leaves a small paste in the buffer', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick();

    stdin.write('fix this\rand that');
    await tick();

    const frame = plain(lastFrame());
    expect(frame).toContain('fix this');
    expect(frame).toContain('and that');
    expect(frame).not.toContain('Pasted');
  });

  it('inserts verbatim when the host has nowhere to park the text', async () => {
    const { stdin, lastFrame } = render(<Harness withPasteStore={false} />);
    await tick();

    stdin.write(bigPaste(14));
    await tick();

    expect(plain(lastFrame())).toContain('line 13');
  });

  it('abandons a paste on ctrl-c mid-flight', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick();

    stdin.write(bigPaste(400));
    stdin.write('\x03');
    await tick();

    expect(plain(lastFrame())).not.toContain('Pasted');
  });
});

describe('clampToViewport', () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');

  it('leaves a buffer that fits the frame alone', () => {
    const value = lines(5);
    expect(clampToViewport(value, 3, 40)).toEqual({ text: value, cursor: 3 });
  });

  it('windows a buffer taller than the frame around the cursor', () => {
    const value = lines(100);
    const cursor = value.indexOf('l50');
    const { text, cursor: shifted } = clampToViewport(value, cursor, 24);
    expect(text).toContain('lines above');
    expect(text).toContain('lines below');
    expect(text).toContain('l50');
    expect(text).not.toContain('l99');
    // The cursor still points at the same character inside the window.
    expect(text.slice(shifted, shifted + 3)).toBe('l50');
  });

  it('keeps the end of the buffer visible when the cursor is at the end', () => {
    const value = lines(100);
    const { text, cursor } = clampToViewport(value, value.length, 24);
    expect(text).toContain('l99');
    expect(text).not.toContain('lines below');
    expect(cursor).toBe(text.length);
  });
});

describe('typing up to the wrap edge', () => {
  it('keeps the prompt and the right border in place while the buffer wraps', async () => {
    // App's gutter: the box's marginX={-1} assumes it.
    const { stdin, lastFrame } = render(
      <Box paddingX={1}>
        <Harness withPasteStore={false} />
      </Box>,
    );
    await tick();
    stdin.write('the quick brown fox jumps over the lazy dog and keeps running along the river');
    await tick();
    for (const ch of ' bank until something') {
      stdin.write(ch);
      await tick();
      const rows = plain(lastFrame())
        .split('\n')
        .filter(r => r !== '');
      const body = rows.filter(r => r.startsWith('│'));
      expect(body[0]).toMatch(/^│ > the quick/);
      for (const row of rows) expect(row.length).toBe(rows[0].length);
      // The cursor wraps with the word it ends, never onto a row of its own.
      for (const row of body.slice(1)) expect(row).not.toMatch(/^│\s*│$/);
    }
  });
});
