import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Box, render, Text } from 'ink';
import { Scrollback } from './Scrollback.js';
import { frameRise } from './framedrops.js';
import type { Message } from '../types.js';

// Ink reads `CI` once, at import, and in CI never erases the live frame — every rise reads 0 there,
// so the jump this file measures cannot happen and the holding tests would pass for nothing.
const ciAtLoad = vi.hoisted(() => {
  const prev = process.env.CI;
  process.env.CI = '0';
  return prev;
});
afterAll(() => {
  if (ciAtLoad === undefined) delete process.env.CI;
  else process.env.CI = ciAtLoad;
});

// Driven through Ink's real writes, because a rise is the erase of the live frame against the rows
// a commit prints in its place, and only the bytes the terminal gets hold both.
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  private buf = '';
  write(s: string): boolean {
    this.buf += s;
    return true;
  }
  take(): string {
    const out = this.buf;
    this.buf = '';
    return out;
  }
}

type Props = { messages: Message[]; reasoning?: string; content?: string; note?: boolean };

function Frame({ messages, reasoning = '', content = '', note = false }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Scrollback
        messages={messages}
        streaming={content}
        streamingReasoning={reasoning}
        streamingTool=""
        streamingNote={note}
        showHeldWorked={false}
      />
      <Text>INPUT</Text>
    </Box>
  );
}

const settle = () => new Promise(r => setTimeout(r, 50));
const user: Message = { role: 'user', content: 'hi' };
const stopped: Message = {
  role: 'system',
  tone: 'warn',
  content: 'Reasoning was repeating itself — stopped it.',
};
const reasoning = Array.from({ length: 60 }, (_, i) => `thinking line ${i}`).join('\n\n');

describe('a discarded stream', () => {
  const prev = { rows: process.stdout.rows, columns: process.stdout.columns };
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'rows', { value: prev.rows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: prev.columns, configurable: true });
  });

  async function riseOf(live: Props, after: Message[]): Promise<number> {
    const out = new FakeStdout();
    const r = render(<Frame {...live} />, { stdout: out as never, patchConsole: false });
    await settle();
    out.take();
    r.rerender(<Frame messages={after} />);
    await settle();
    const rise = frameRise(out.take()) ?? -1;
    r.unmount();
    return rise;
  }

  it('lifts the input by the block’s height when it is erased under a notice', async () => {
    expect(await riseOf({ messages: [user], reasoning }, [user, stopped])).toBeGreaterThan(20);
  });

  it('holds the input when it is frozen into the scrollback instead', async () => {
    const frozen: Message = { role: 'assistant', content: '', reasoning, discarded: 'stream' };
    expect(await riseOf({ messages: [user], reasoning }, [user, frozen, stopped])).toBe(0);
  });

  it('holds the input for a compaction-note attempt, drawn in the note’s shape', async () => {
    const content = 'Compaction note 1\n\nEstablished:\n- a';
    const frozen: Message = { role: 'assistant', content, reasoning, discarded: 'note' };
    const live = { messages: [user], reasoning, content, note: true };
    expect(await riseOf(live, [user, frozen])).toBe(0);
  });
});
