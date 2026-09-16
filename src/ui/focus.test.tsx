import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Input } from './Input.js';
import { FOCUS_REPORT_OFF, FOCUS_REPORT_ON, isFocusKeypress, parseFocusEvent } from './focus.js';

const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const BLOCK = '\x1b[7m'; // inverse video: the drawn cursor
const FAINT_BLOCK = '\x1b[2m\x1b[7m'; // the unfocused variant

// Let Ink flush the keypress through React state into the next frame.
const tick = (ms = 30): Promise<void> => new Promise(r => setTimeout(r, ms));

function Harness({ placeholder }: { placeholder?: string }) {
  const [value, setValue] = useState('');
  return (
    <Input
      value={value}
      onChange={setValue}
      onSubmit={() => setValue('')}
      disabled={false}
      mode="agent"
      suggesting={false}
      history={[]}
      placeholder={placeholder}
    />
  );
}

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('focus sequences', () => {
  it('recognises the raw reports and nothing else', () => {
    expect(parseFocusEvent(FOCUS_IN)).toBe('in');
    expect(parseFocusEvent(FOCUS_OUT)).toBe('out');
    expect(parseFocusEvent('\x1b[H')).toBeNull();
    expect(parseFocusEvent('I')).toBeNull();
  });

  it('recognises the ESC-stripped form Ink hands to useInput', () => {
    expect(isFocusKeypress('[I')).toBe(true);
    expect(isFocusKeypress('[O')).toBe(true);
    expect(isFocusKeypress('[')).toBe(false);
    expect(isFocusKeypress('I')).toBe(false);
  });
});

describe('Input on window focus change', () => {
  it('holds the cursor solid and faint while unfocused, and blinks again on focus', async () => {
    const { stdin, lastFrame, frames } = render(<Harness />);
    await tick();
    stdin.write('ab');
    await tick();
    expect(lastFrame()).toContain(BLOCK);
    expect(lastFrame()).not.toContain(FAINT_BLOCK);

    stdin.write(FOCUS_OUT);
    await tick();
    expect(lastFrame()).toContain(FAINT_BLOCK);
    // Past a full blink period every frame still carries the block: no blink, no repaint churn.
    const from = frames.length;
    await tick(700);
    expect(frames.length).toBe(from);
    expect(lastFrame()).toContain(FAINT_BLOCK);

    stdin.write(FOCUS_IN);
    await tick();
    expect(lastFrame()).toContain(BLOCK);
    expect(lastFrame()).not.toContain(FAINT_BLOCK);
    // Blinking resumed: within a period the block goes away, and comes back.
    await tick(600);
    expect(lastFrame()).not.toContain(BLOCK);
    await tick(600);
    expect(lastFrame()).toContain(BLOCK);
  });

  it('applies the same treatment to the placeholder cursor', async () => {
    const { stdin, lastFrame } = render(<Harness placeholder="ask anything" />);
    await tick();
    expect(lastFrame()).toContain(`${BLOCK}a`);

    stdin.write(FOCUS_OUT);
    await tick();
    expect(lastFrame()).toContain(`${FAINT_BLOCK}a`);
    expect(plain(lastFrame())).toContain('ask anything');
  });

  it('never inserts a focus report into the buffer', async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await tick();
    stdin.write('a');
    await tick();
    stdin.write(FOCUS_OUT);
    await tick();
    stdin.write(FOCUS_IN);
    await tick();
    stdin.write('b');
    await tick();
    expect(plain(lastFrame())).toContain('> ab');
    expect(plain(lastFrame())).not.toContain('[I');
    expect(plain(lastFrame())).not.toContain('[O');
  });

  it('switches focus reporting on for a TTY and off again on unmount', async () => {
    const r = render(<Harness />);
    // The effect runs after mount; flag the fake stdout as a terminal before it does.
    Object.assign(r.stdout, { isTTY: true });
    await tick();
    expect(r.frames).toContain(FOCUS_REPORT_ON);
    expect(r.frames).not.toContain(FOCUS_REPORT_OFF);
    r.unmount();
    await tick();
    expect(r.frames).toContain(FOCUS_REPORT_OFF);
  });

  it('leaves a non-TTY stdout alone', async () => {
    const r = render(<Harness />);
    await tick();
    r.unmount();
    await tick();
    expect(r.frames).not.toContain(FOCUS_REPORT_ON);
    expect(r.frames).not.toContain(FOCUS_REPORT_OFF);
  });
});
