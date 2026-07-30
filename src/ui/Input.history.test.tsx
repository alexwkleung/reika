import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Input } from './Input.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

// Let Ink flush the keypress through React state into the next frame.
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 30));

// Drives Input as a controlled component the way App does: keeps the value in
// state, records submissions into a history list, and clears on submit.
function Harness({ seed = [] as string[] }) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>(seed);
  return (
    <Input
      value={value}
      onChange={setValue}
      onSubmit={v => {
        const trimmed = v.trim();
        if (trimmed) {
          setHistory(prev => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
        }
        setValue('');
      }}
      disabled={false}
      mode="agent"
      suggesting={false}
      history={history}
    />
  );
}

// The cursor is drawn as an inverse-video block; strip it (and any other ANSI)
// so assertions compare against the plain buffer text.
function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('Input history recall', () => {
  it('walks older entries on ArrowUp and back to the draft on ArrowDown', async () => {
    const { stdin, lastFrame } = render(<Harness seed={['first', 'second']} />);
    await tick(); // let the raw-mode listener attach before writing

    stdin.write(UP);
    await tick();
    expect(plain(lastFrame())).toContain('second');

    stdin.write(UP);
    await tick();
    expect(plain(lastFrame())).toContain('first');

    // Already at the oldest entry — stays put.
    stdin.write(UP);
    await tick();
    expect(plain(lastFrame())).toContain('first');

    stdin.write(DOWN);
    await tick();
    expect(plain(lastFrame())).toContain('second');

    // Past the newest entry — restores the (empty) draft.
    stdin.write(DOWN);
    await tick();
    const frame = plain(lastFrame());
    expect(frame).not.toContain('second');
    expect(frame).not.toContain('first');
  });

  it('preserves an in-progress draft when recalling and returning', async () => {
    const { stdin, lastFrame } = render(<Harness seed={['old']} />);
    await tick(); // let the raw-mode listener attach before writing

    stdin.write('draft');
    await tick();
    expect(plain(lastFrame())).toContain('draft');

    stdin.write(UP);
    await tick();
    expect(plain(lastFrame())).toContain('old');

    stdin.write(DOWN);
    await tick();
    expect(plain(lastFrame())).toContain('draft');
  });

  it('does nothing on ArrowUp/ArrowDown with no history', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick(); // let the raw-mode listener attach before writing
    stdin.write(UP);
    await tick();
    stdin.write(DOWN);
    await tick();
    // Nothing recalled: only the empty box (border + prompt) remains.
    expect(plain(lastFrame()).replace(/[╭─╮│╰╯>?\s]/g, '')).toBe('');
  });

  it('records a submitted message into history', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick(); // let the raw-mode listener attach before writing

    stdin.write('hello');
    await tick();
    stdin.write('\r');
    await tick(); // submit clears the buffer
    expect(plain(lastFrame())).not.toContain('hello');

    stdin.write(UP);
    await tick(); // recall it
    expect(plain(lastFrame())).toContain('hello');
  });
});
