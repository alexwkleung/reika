import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';

// The dropped-payload notice (#227) is gated by DROPPED_LEDGER, a module const read at loop.js
// import time, so the flag must be set before the import. This file covers the two DEFAULT-mode
// compositions (system suffix); the prefix-stable pair, which runs through a different code path in
// each mode, is in loop.droppedpayload.prefixstable.test.ts. loop.test.ts holds the flag-off guard.
process.env.REIKA_DROPPED_LEDGER = '1';
const { buildSteadySystem } = await import('./loop.js');

const explored: Message[] = [
  { role: 'user', content: 'work on issue 213' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'gh issue view 213' } }],
  },
];
// c1 HAD a payload and sits outside the trailing tool block, so this request serializes it as a
// bare summary — the state that reads to a model as "already handled".
const dropped: Message[] = [
  ...explored,
  {
    role: 'tool',
    callId: 'c1',
    summary: 'Ran: gh issue view 213 (505 bytes output)',
    payload: 'ISSUE',
  },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', args: {} }] },
  { role: 'tool', callId: 'c2', summary: 'Read b.ts', payload: 'BODY' },
];
// Same shape, but nothing was ever dropped: c1's result carried no payload to lose.
const clean: Message[] = [
  ...explored,
  { role: 'tool', callId: 'c1', summary: 'Ran: gh issue view 213 (0 bytes output)' },
];

describe('dropped-payload notice in the system suffix (#227)', () => {
  for (const promptMode of ['agent', 'plan'] as const) {
    it(`names dropped payloads once, ahead of the other ledgers, in ${promptMode} mode`, () => {
      const s = buildSteadySystem({
        baseSystem: 'BASE',
        promptMode,
        history: dropped,
        round: 0,
        planSteps: null,
      });
      expect(s).toContain('Their output was dropped to make room');
      expect(s).toContain('re-run that call');
      // Stated exactly once, however many payloads were dropped.
      expect(s.split('Their output was dropped to make room')).toHaveLength(2);
      // Settled context first, directives after — the plan ledger follows it.
      expect(s.startsWith('BASE\n\n--- reika status')).toBe(true);
    });

    it(`stays silent in ${promptMode} mode when nothing was dropped`, () => {
      const s = buildSteadySystem({
        baseSystem: 'BASE',
        promptMode,
        history: clean,
        round: 0,
        planSteps: null,
      });
      expect(s).not.toContain('dropped to make room');
    });
  }
});
