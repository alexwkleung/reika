import { describe, expect, it } from 'vitest';

import { CONTINUATION_SHED_NOTE, batchAgePayloads } from './compaction.js';
import type { Message } from '../types.js';

// The carried tail's lifecycle (#284). Promoting a cut-off block into `content` makes it visible to
// the chat template, but assistant content has no eviction branch of its own — aging and capping
// only ever touched tool payloads — so without this the promotion would be a standing window cost
// that only a fold could clear. These pin the two halves: protected while the continuation it feeds
// is live, first to shed once spent.

const CARRIED = 'the previous line is [0, 1), and pos should become the end of that line';

function tailMsg(content = CARRIED): Message {
  return { role: 'assistant', content, continuationTail: true };
}

function toolMsg(id: string, payload: string): Message {
  return { role: 'tool', callId: id, summary: `ran ${id}`, payload };
}

// Always over the watermark, so the sweep runs to exhaustion and every eligible message is marked.
const overBudget = (): number => 1_000_000;

describe('spent continuation tail', () => {
  it('sheds first, ahead of bulk tool payloads', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      toolMsg('t1', 'x'.repeat(9000)),
      tailMsg(),
      { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'read', args: {} }] },
      toolMsg('t2', 'y'.repeat(9000)),
    ];
    // Allow exactly one mark, then report the window as clear: whatever the sweep takes first is
    // what it considers most expendable. The tail must win that race for the same reason reasoning
    // does — the model cannot re-fetch its own thinking, so dropping it can never provoke the
    // re-read that makes aging a small payload a false economy (#257). (Call 0 is the entry guard,
    // call 1 is the first candidate's check; from call 2 the sweep sees itself as done.)
    const shed = (): boolean =>
      history[2].role === 'assistant' && history[2].content === CONTINUATION_SHED_NOTE;
    batchAgePayloads(history, () => (shed() ? 0 : 1_000_000), 24_000);

    expect(history[2].role === 'assistant' && history[2].content).toBe(CONTINUATION_SHED_NOTE);
    expect(history[1].role === 'tool' && history[1].aged).toBeFalsy();
  });

  it('leaves a live tail alone — it is inside the protected active roundtrip', () => {
    // History ends with the carried tail and its resume nudge, which is exactly the shape while the
    // continuation is in flight. protectedTailStart lands on the tail, so the sweep never reaches it.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      toolMsg('t1', 'x'.repeat(9000)),
      tailMsg(),
      { role: 'user', content: '(your previous response was cut off at the token limit...)' },
    ];
    batchAgePayloads(history, overBudget, 24_000);

    expect(history[2].role === 'assistant' && history[2].content).toBe(CARRIED);
  });

  it('is idempotent — a shed tail is not re-marked on the next event', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      tailMsg(),
      { role: 'assistant', content: 'done' },
    ];
    const first = batchAgePayloads(history, overBudget, 24_000);
    const second = batchAgePayloads(history, overBudget, 24_000);

    expect(first.marked).toBeGreaterThan(0);
    expect(second.marked).toBe(0);
    expect(history[1].role === 'assistant' && history[1].content).toBe(CONTINUATION_SHED_NOTE);
  });
});
