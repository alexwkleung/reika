import { afterAll, describe, expect, it } from 'vitest';
import type { Message } from '../types.js';

// The dedup layer is gated by a module-const flag read at import time, so — like loop.planhandoff.test
// — set the env BEFORE importing the module under test, then restore it after.
const PRIOR = process.env.REIKA_DEDUP_PAYLOADS;
process.env.REIKA_DEDUP_PAYLOADS = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_DEDUP_PAYLOADS;
  else process.env.REIKA_DEDUP_PAYLOADS = PRIOR;
});

const { messagesToOpenAI } = await import('./toolcall.js');

// Total serialized characters of a built request — content plus tool_call JSON.
function requestChars(out: unknown[]): number {
  return (out as Array<{ content?: unknown; tool_calls?: unknown }>).reduce((n, m) => {
    const content = typeof m.content === 'string' ? m.content.length : 0;
    const calls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
    return n + content + calls;
  }, 0);
}

describe('messagesToOpenAI with REIKA_DEDUP_PAYLOADS=1', () => {
  it('collapses a repeated aged read trail while keeping the current read whole', () => {
    // The model re-read A three rounds running. Rounds 1-2 have aged to summary-only; round 3 is the
    // fresh block. The byte-identical aged summary in round 2 is the cross-round attractor — it gets
    // stubbed, round 1 keeps the (first) summary, and the current round keeps its full payload.
    const readA = (id: string, payload?: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: { path: 'A' } }] },
      {
        role: 'tool',
        callId: id,
        summary: 'Read A lines 1-10 of 10',
        // Past the crumb floor (#257), so the aged copies collapse to their summary and the trail
        // this case is about actually exists.
        payload: payload ?? 'PAYLOAD_A\n'.repeat(300),
      },
    ];
    // The opening `list` keeps the #227 task-spec pin off c1, so this exercises the aged trail
    // rather than the pin (which is covered in toolcall.test.ts).
    const history: Message[] = [
      { role: 'user', content: 'inspect A' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'list', args: {} }] },
      { role: 'tool', callId: 'c0', summary: 'Listed 3 entries', payload: 'A\nB\nC' },
      ...readA('c1'),
      ...readA('c2'),
      ...readA('c3', 'PAYLOAD_A_FRESH'),
    ];
    const out = messagesToOpenAI('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const c1 = out.find(m => m.tool_call_id === 'c1');
    const c2 = out.find(m => m.tool_call_id === 'c2');
    const c3 = out.find(m => m.tool_call_id === 'c3');
    // First occurrence kept; repeat collapsed to a back-reference; current read full.
    expect(c1?.content).toBe('Read A lines 1-10 of 10');
    expect(c2?.content).toContain('repeat of an earlier identical result');
    expect(c2?.content).not.toContain('Read A lines'); // the duplicated summary is gone
    expect(c3?.content).toContain('PAYLOAD_A_FRESH');
  });

  it('collapses simultaneous identical fresh payloads, keeping one whole', () => {
    // A parallel batch that read the same file twice in one round: two full identical payloads are in
    // context at once. One survives with its body; the other keeps its summary + a back-reference.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read', args: { path: 'A' } },
          { id: 'b', name: 'read', args: { path: 'A' } },
        ],
      },
      { role: 'tool', callId: 'a', summary: 'Read A lines 1-5 of 5', payload: 'DUP_BODY' },
      { role: 'tool', callId: 'b', summary: 'Read A lines 1-5 of 5', payload: 'DUP_BODY' },
    ];
    const out = messagesToOpenAI('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const a = out.find(m => m.tool_call_id === 'a');
    const b = out.find(m => m.tool_call_id === 'b');
    expect(a?.content).toContain('DUP_BODY'); // first kept whole
    expect(b?.content).toContain('you already have it'); // second stubbed
    expect(b?.content).not.toContain('DUP_BODY');
    expect(b?.content).toContain('Read A lines 1-5 of 5'); // summary retained on a fresh stub
  });

  it('frees the stubbed dup budget for the surviving payload (fit-to-window)', () => {
    // Two identical oversized fresh payloads under a tight window. The stubbed dup no longer claims a
    // share of the fresh budget, so the survivor keeps more than the naive half-split would allow —
    // and the whole request still fits the window.
    const big = 'Z'.repeat(100_000);
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read', args: { path: 'A' } },
          { id: 'b', name: 'read', args: { path: 'A' } },
        ],
      },
      { role: 'tool', callId: 'a', summary: 's', payload: big },
      { role: 'tool', callId: 'b', summary: 's', payload: big },
    ];
    const contentFor = (out: unknown[], id: string): string =>
      (out.find(m => (m as { tool_call_id?: string }).tool_call_id === id) as { content: string })
        .content;

    const out = messagesToOpenAI('sys', history, { contextWindow: 16384 });
    expect(contentFor(out, 'b')).toContain('you already have it'); // dup stubbed, not capped
    expect(contentFor(out, 'b')).not.toContain('to fit the context window');
    expect(contentFor(out, 'a')).toContain('to fit the context window'); // survivor still capped

    // Control: the SAME window with two DISTINCT payloads (nothing to dedup) splits the budget in
    // half. The deduped survivor above kept the whole fresh budget, so it must be materially larger.
    const control: Message[] = [
      history[0],
      history[1],
      { role: 'tool', callId: 'a', summary: 's', payload: `${big}A` },
      { role: 'tool', callId: 'b', summary: 's', payload: `${big}B` },
    ];
    const controlOut = messagesToOpenAI('sys', control, { contextWindow: 16384 });
    expect(contentFor(out, 'a').length).toBeGreaterThan(contentFor(controlOut, 'a').length * 1.5);
    expect(requestChars(out)).toBeLessThanOrEqual(16384 * 4);
  });

  it('never collapses a repeated failure to an outcome-neutral stub (qq2 req-013 regression)', () => {
    // Captured bug: the model retried a failed edit; the second, byte-identical "Edit failed"
    // summary (summary-only → never "fresh") deduped to "(… omitted)" — and the model, seeing no
    // outcome, concluded the retry succeeded. The repeat stub must carry the outcome verbatim.
    const fail =
      'Edit failed: old_string not found in src/scripts/discover.ts. No line matches it even ignoring whitespace';
    const history: Message[] = [
      { role: 'user', content: 'implement the plan' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'e1', name: 'edit', args: {} }] },
      { role: 'tool', callId: 'e1', summary: fail },
      { role: 'assistant', content: '', toolCalls: [{ id: 'e2', name: 'edit', args: {} }] },
      { role: 'tool', callId: 'e2', summary: fail },
    ];
    const out = messagesToOpenAI('sys', history) as unknown as Array<{
      tool_call_id?: string;
      content?: string;
    }>;
    const first = out.find(m => m.tool_call_id === 'e1');
    const repeat = out.find(m => m.tool_call_id === 'e2');
    expect(first?.content).toBe(fail);
    // The repeat is still marked as a repeat (the anti-loop signal)…
    expect(repeat?.content).toContain('repeat of an earlier identical result');
    // …but the outcome must survive: the model has to see the edit failed AGAIN.
    expect(repeat?.content).toContain('Edit failed');
    expect(repeat?.content).toContain('old_string not found');
  });

  it('preserves outcome-bearing summaries from every tool in the repeat stub', () => {
    const outcomes = [
      'Bash failed: npm test (exit 1)',
      // #200: a non-zero exit reports as a plain `Ran:` line now, carrying none of the failure
      // words the rest of this list is caught by. If the repeat stub swallowed it, a model retrying
      // a red test run would see the second attempt collapse to "same as before" with the exit code
      // gone — the exact regression this test was written for, one summary rewrite later.
      'Ran: npm test (exit 1, 4120 bytes output)',
      'Ran: make build (killed by SIGKILL, 12 bytes output)',
      'Bash timeout: sleep 999 (killed after 30s)',
      'Bash declined by user: rm -rf dist',
      'Fetch budget exceeded for this turn (max 3). Summarize what you have or split into multiple turns.',
      'Invalid regex: Unterminated group',
      'No results for "flux capacitor"',
      'Found 0 matches for /missing_symbol/',
      'Read src/a.ts: offset 900 past end of file (100 lines)',
      'Write failed: src/a.ts already exists; use edit instead',
    ];
    for (const summary of outcomes) {
      const history: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] },
        { role: 'tool', callId: 'c1', summary },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'bash', args: {} }] },
        { role: 'tool', callId: 'c2', summary },
      ];
      const out = messagesToOpenAI('sys', history) as unknown as Array<{
        tool_call_id?: string;
        content?: string;
      }>;
      const repeat = out.find(m => m.tool_call_id === 'c2');
      expect(repeat?.content, summary).toContain(summary);
    }
  });
});
