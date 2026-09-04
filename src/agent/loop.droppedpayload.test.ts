import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';

// The dropped-payload notice (#227) is gated by DROPPED_LEDGER, a module const read at loop.js
// import time, so the flag must be set before the import. This file covers the two DEFAULT-mode
// compositions (system suffix); the prefix-stable pair, which runs through a different code path in
// each mode, is in loop.droppedpayload.prefixstable.test.ts. loop.test.ts holds the flag-off guard.
process.env.REIKA_DROPPED_LEDGER = '1';
const { DROPPED_LEDGER_MARKER, buildDroppedPayloadLedger, buildSteadySystem } =
  await import('./loop.js');

const explored: Message[] = [
  { role: 'user', content: 'work on issue 213' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'gh issue view 213' } }],
  },
];
// c1 is the turn's PINNED task spec (#228) and stays live, so it is c2 that HAD a payload, sits
// outside the trailing tool block, and now serializes as a bare summary — the state that reads to a
// model as "already handled". Keeping the spec in the fixture is deliberate: it also proves the pin
// exclusion doesn't suppress a real drop happening alongside it.
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
  { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', args: {} }] },
  { role: 'tool', callId: 'c3', summary: 'Read c.ts', payload: 'FRESH' },
];
// Same shape, but nothing was ever dropped: c1's result carried no payload to lose.
const clean: Message[] = [
  ...explored,
  { role: 'tool', callId: 'c1', summary: 'Ran: gh issue view 213 (0 bytes output)' },
];
// The pin's own case: c1 DID carry a payload, but it is the pinned spec and therefore still live.
// A request that dropped nothing must not claim it did (#228 reconcile).
const pinnedOnly: Message[] = [
  ...explored,
  {
    role: 'tool',
    callId: 'c1',
    summary: 'Ran: gh issue view 213 (505 bytes output)',
    payload: 'ISSUE',
  },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', args: {} }] },
  { role: 'tool', callId: 'c2', summary: 'Read b.ts', payload: 'FRESH' },
];

describe('dropped-payload notice in the system suffix (#227)', () => {
  // The debug line detects the notice by searching the composed request for this exact sentence,
  // so a reworded ledger must not be able to leave that detection silently broken.
  it('the marker the debug line looks for is really in the ledger', () => {
    expect(buildDroppedPayloadLedger()).toContain(DROPPED_LEDGER_MARKER);
  });

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

    it(`stays silent in ${promptMode} mode when the only summary-only payload is the pin`, () => {
      const s = buildSteadySystem({
        baseSystem: 'BASE',
        promptMode,
        history: pinnedOnly,
        round: 0,
        planSteps: null,
      });
      expect(s).not.toContain('dropped to make room');
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
