import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';

// The dropped-payload notice (#227) is on by default; `=0` is the A/B baseline arm and must be a
// strict no-op. DROPPED_LEDGER is a module const read at loop.js import time, so the flag is set
// before the import — which is why this lives in its own file rather than beside the default check
// in loop.test.ts.
process.env.REIKA_DROPPED_LEDGER = '0';
const { DROPPED_LEDGER_MARKER, buildSteadySystem } = await import('./loop.js');

const dropped: Message[] = [
  { role: 'user', content: 'work on issue 213' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'gh issue view 213' } }],
  },
  { role: 'tool', callId: 'c1', summary: 'Ran: gh (505 bytes output)', payload: 'ISSUE' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', args: {} }] },
  { role: 'tool', callId: 'c2', summary: 'Read b.ts', payload: 'BODY' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', args: {} }] },
  { role: 'tool', callId: 'c3', summary: 'Read c.ts', payload: 'BODY' },
];

describe('REIKA_DROPPED_LEDGER=0', () => {
  it('composes no notice in either prompt mode even with a dropped payload present', () => {
    for (const promptMode of ['agent', 'plan'] as const) {
      const s = buildSteadySystem({
        baseSystem: 'BASE',
        promptMode,
        history: dropped,
        round: 0,
        planSteps: null,
      });
      expect(s).not.toContain(DROPPED_LEDGER_MARKER);
    }
  });
});
