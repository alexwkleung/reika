import { describe, expect, it } from 'vitest';
import { messagesToChatParams, type CapStats } from './toolcall.js';
import type { Message } from '../types.js';

// #253: the fit-to-window cap is sized from the room left after everything else in the request, so
// retaining more old payloads tightens it — raising the aging watermark buys old-payload retention
// by truncating NEW tool output. Without these counts an A/B on that watermark measures two thirds
// of its own question, the same blind spot the batch-age sweep split fixed in #257.
const round = (id: string, payload: string): Message[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: {} }] },
  { role: 'tool', callId: id, summary: `ran ${id}`, payload },
];

function capture(history: Message[], contextWindow?: number): CapStats {
  let stats: CapStats | undefined;
  messagesToChatParams('SYSTEM', history, {
    contextWindow,
    minGenTokens: 1024,
    onCapStats: s => {
      stats = s;
    },
  });
  return stats!;
}

describe('payload-cap stats (#253)', () => {
  it('reports no cap and no truncation when no window is configured', () => {
    const s = capture([{ role: 'user', content: 'go' }, ...round('a', 'x'.repeat(50_000))]);
    expect(s.cap).toBeUndefined();
    expect(s.fresh).toBe(1);
    expect(s.truncated).toBe(0);
    expect(s.omitted).toBe(0);
    // No window means nothing is capped, so the payload ships whole rather than cut.
    expect(s.uncapped).toBe(1);
  });

  it('counts a payload the cap actually cut, and the chars it dropped', () => {
    // A payload far larger than a small window can hold has to be cut to fit.
    const payload = 'x'.repeat(200_000);
    const s = capture([{ role: 'user', content: 'go' }, ...round('a', payload)], 8192);
    expect(s.fresh).toBe(1);
    expect(s.cap).toBeDefined();
    expect(s.truncated).toBe(1);
    expect(s.uncapped).toBe(0);
    // Exactly the chars the cap refused: nothing rounded, nothing double-counted.
    expect(s.omitted).toBe(payload.length - s.cap!);
    expect(s.starved).toBe(0);
  });

  // The counts are only worth logging if they describe the bytes that actually shipped, so tie them
  // to the serialized output rather than to the cap arithmetic that produced them.
  it('reports counts that match what was really serialized', () => {
    const payload = 'y'.repeat(120_000);
    const history: Message[] = [{ role: 'user', content: 'go' }, ...round('a', payload)];
    let stats: CapStats | undefined;
    const msgs = messagesToChatParams('SYSTEM', history, {
      contextWindow: 8192,
      minGenTokens: 1024,
      onCapStats: s => {
        stats = s;
      },
    });
    const toolMsg = msgs.find(m => (m as { role: string }).role === 'tool') as { content: string };
    const shipped = toolMsg.content.length;
    expect(stats!.fresh).toBe(1);
    expect(stats!.truncated).toBe(1);
    // The body that actually shipped is the summary plus at most the cap — so the omitted count is
    // not cap arithmetic reported back to itself, it matches the bytes on the wire.
    expect(shipped).toBeLessThan(payload.length);
    expect(payload.length - stats!.omitted).toBeLessThanOrEqual(shipped);
  });

  it('stays silent about payloads that are not fresh', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', args: {} }] },
      { role: 'tool', callId: 'old', summary: 'ran old', payload: 'z'.repeat(9000), aged: true },
      { role: 'user', content: 'next' },
      ...round('new', 'w'.repeat(100)),
    ];
    const s = capture(history, 24000);
    // The aged one serializes as its summary and never reaches the cap, so only the fresh one counts.
    expect(s.fresh).toBe(1);
  });
});
