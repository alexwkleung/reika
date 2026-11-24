import { describe, expect, it } from 'vitest';
import { messagesToChatParams, type AgedStats } from './toolcall.js';
import type { Message } from '../types.js';

// An aged bash result used to serialize as `Ran: cmd (exit 1, N bytes output)`: the spill locator
// and the failure lines went with the payload, so the only way back to either was re-running the
// command. It now keeps the locator, and a failed run keeps its last lines.

const LOG = Array.from({ length: 120 }, (_, i) => `  ✓ test ${i} ${'.'.repeat(30)}`).join('\n');
const FOOTER =
  '\n\n(Showing 65536 of 234000 bytes. Full output saved to /tmp/reika-a1b2c3/bash-1.txt — ' +
  'read that path with offset/limit to page through it, or grep it to narrow. ' +
  'Do not re-run this command to see the rest.)';
const TAIL = [
  '  ✓ test 118',
  ' FAIL  src/a.test.ts > parses the header',
  'AssertionError: expected 3 to be 4',
  ' Tests  1 failed | 119 passed',
].join('\n');

type Bash = Extract<Message, { role: 'tool' }>;
const bash = (over: Partial<Bash>): Bash => ({
  role: 'tool',
  callId: 'b',
  summary: 'Ran: npm test (exit 1, 234000 bytes output)',
  payload: LOG,
  exitCode: 1,
  command: { text: 'npm test', outputTail: TAIL, outputTruncated: true },
  ...over,
});

// Same shape as toolcall.reportaged.test: a spec-pin holder first so the slot under test ages, and
// a huge trailing read so the window is over budget.
const history = (msg: Bash): Message[] => [
  { role: 'user', content: 'fix the tests' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'grep', args: {} }] },
  { role: 'tool', callId: 'spec', summary: 'Found 3 matches', payload: 'a\nb\nc' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'bash', args: {} }] },
  msg,
  { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
  { role: 'tool', callId: 'z', summary: 'Read x', payload: 'Z'.repeat(40_000) },
];

function serialize(h: Message[]): { aged: string; stats: AgedStats } {
  let stats: AgedStats | undefined;
  const out = messagesToChatParams('sys', h, {
    contextWindow: 8192,
    onAgedStats: s => {
      stats = s;
    },
  }) as Array<{ tool_call_id?: string; content: string }>;
  return { aged: out.find(m => m.tool_call_id === 'b')!.content, stats: stats! };
}

describe('aged bash result keeps its locator and failure lines', () => {
  it('keeps the spill path and the last lines of a failed run', () => {
    const { aged, stats } = serialize(history(bash({ payload: LOG + FOOTER })));
    expect(aged.startsWith('Ran: npm test (exit 1, 234000 bytes output)')).toBe(true);
    expect(aged).toContain('/tmp/reika-a1b2c3/bash-1.txt');
    expect(aged).toContain('AssertionError: expected 3 to be 4');
    expect(aged).toContain('Tests  1 failed | 119 passed');
    // Three lines of the run's end, not the chip's ten, and not the payload's own end.
    expect(aged).not.toContain('✓ test 118');
    expect(aged).not.toContain('test 119');
    expect(stats.command).toBe(1);
    expect(stats.summary).toBe(0);
  });

  it('keeps only the locator for a clean exit', () => {
    const { aged, stats } = serialize(
      history(
        bash({
          summary: 'Ran: npm test (234000 bytes output)',
          payload: LOG + FOOTER,
          exitCode: 0,
        }),
      ),
    );
    expect(aged).toContain('/tmp/reika-a1b2c3/bash-1.txt');
    expect(aged).not.toContain('AssertionError');
    expect(stats.command).toBe(1);
  });

  it('keeps the failure lines when nothing was spilled', () => {
    const { aged } = serialize(history(bash({})));
    expect(aged).toContain('AssertionError: expected 3 to be 4');
    expect(aged).not.toContain('saved output is at');
  });

  it('treats a run killed by a signal as failed', () => {
    const { aged } = serialize(history(bash({ exitCode: null })));
    expect(aged).toContain('AssertionError');
  });

  it('caps a long tail line', () => {
    const long = 'E'.repeat(1000);
    const { aged } = serialize(
      history(bash({ command: { text: 'x', outputTail: long, outputTruncated: false } })),
    );
    expect(aged).toContain(`${'E'.repeat(200)}…`);
    expect(aged).not.toContain('E'.repeat(201));
  });

  it('stays the summary for a clean run with nothing saved', () => {
    const { aged, stats } = serialize(
      history(bash({ summary: 'Ran: ls (5000 bytes output)', exitCode: 0 })),
    );
    expect(aged).toBe('Ran: ls (5000 bytes output)');
    expect(stats.summary).toBe(1);
    expect(stats.command).toBe(0);
  });
});
