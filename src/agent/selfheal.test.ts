import { describe, it, expect } from 'vitest';
import { exciseSpiral, buildAppliedLedger, formatAppliedLedger } from './selfheal.js';
import { shingles } from './reasoningtrace.js';
import type { Message } from '../types.js';

// The ruminated text and the rut derived from it, so the fixtures agree with the detector's own
// tokenizer instead of hand-guessing 8-grams.
const RUT_TEXT =
  'the cache invalidation happens before the write completes so the reader sees a stale entry ' +
  'and we must reorder the write so that it lands first before any reader observes it';
const RUT = shingles(RUT_TEXT);
const FRESH =
  'the migration script needs a guard for null tenant ids before it touches any of the billing ' +
  'rows because a null tenant would silently widen the update to every account in the table';

const assistant = (over: Partial<Message & { role: 'assistant' }>): Message => ({
  role: 'assistant',
  content: '',
  ...over,
});

describe('exciseSpiral', () => {
  it('removes a ruminated round that has no tool calls', () => {
    const history: Message[] = [
      { role: 'user', content: 'fix the cache bug' },
      assistant({ reasoning: RUT_TEXT }),
    ];
    const r = exciseSpiral(history, { shingles: RUT });
    expect(r.droppedRounds).toBe(1);
    expect(r.history).toHaveLength(1);
    expect(r.history[0].role).toBe('user');
  });

  // The pairing constraint: an assistant tool call and its `tool` result are joined by callId, and
  // dropping the assistant side alone leaves an orphaned result that malforms the request. A
  // ruminated round that called a tool therefore keeps the call and loses only its reasoning.
  it('keeps a ruminated round that called a tool, stripping only its reasoning', () => {
    const history: Message[] = [
      { role: 'user', content: 'fix the cache bug' },
      assistant({
        reasoning: RUT_TEXT,
        toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
      }),
      { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: 'FILE BYTES' },
    ];
    const r = exciseSpiral(history, { shingles: RUT });
    expect(r.droppedRounds).toBe(0);
    expect(r.strippedReasoning).toBe(1);
    expect(r.history).toHaveLength(3);
    const kept = r.history[1];
    expect(kept.role === 'assistant' && kept.reasoning).toBeUndefined();
    expect(kept.role === 'assistant' && kept.toolCalls?.[0].id).toBe('c1');
    // The result still has something to pair with.
    expect(r.history[2].role === 'tool' && r.history[2].callId).toBe('c1');
  });

  it('leaves a round that is not dominated by the rut alone', () => {
    const history: Message[] = [assistant({ reasoning: FRESH, content: 'done' })];
    const r = exciseSpiral(history, { shingles: RUT });
    expect(r.droppedRounds).toBe(0);
    expect(r.strippedReasoning).toBe(0);
    expect(r.history[0]).toEqual(history[0]);
  });

  it('is a no-op when the detector found no rut', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      assistant({ reasoning: RUT_TEXT }),
    ];
    const r = exciseSpiral(history, { shingles: [] });
    expect(r.history).toHaveLength(2);
    expect(r.freedChars).toBe(0);
  });

  // A spiral is defined by re-reading, so the newest copy is the one the model may still need and
  // every earlier copy is pure weight.
  it('keeps the newest read of a looping path and stubs the earlier ones', () => {
    const history: Message[] = [
      assistant({ toolCalls: [{ id: 'r1', name: 'read', args: { path: 'a.ts' } }] }),
      { role: 'tool', callId: 'r1', summary: 'read a.ts', payload: 'FIRST COPY' },
      assistant({ toolCalls: [{ id: 'r2', name: 'read', args: { path: 'a.ts' } }] }),
      { role: 'tool', callId: 'r2', summary: 'read a.ts', payload: 'NEWEST COPY' },
    ];
    const r = exciseSpiral(history, { shingles: [], loopingReads: ['a.ts'] });
    expect(r.stubbedPayloads).toBe(1);
    expect(r.history).toHaveLength(4); // structure intact, nothing removed
    const first = r.history[1];
    const newest = r.history[3];
    expect(first.role === 'tool' && first.payload).toBeUndefined();
    expect(first.role === 'tool' && first.summary).toBe('read a.ts'); // outcome preserved
    expect(newest.role === 'tool' && newest.payload).toBe('NEWEST COPY');
  });

  it('leaves reads of paths the detector did not flag', () => {
    const history: Message[] = [
      assistant({ toolCalls: [{ id: 'r1', name: 'read', args: { path: 'b.ts' } }] }),
      { role: 'tool', callId: 'r1', summary: 'read b.ts', payload: 'KEEP ME' },
    ];
    const r = exciseSpiral(history, { shingles: [], loopingReads: ['a.ts'] });
    expect(r.stubbedPayloads).toBe(0);
    expect(r.history[1].role === 'tool' && r.history[1].payload).toBe('KEEP ME');
  });

  it('drops harness scaffolding but never what the user actually typed', () => {
    const history: Message[] = [
      { role: 'user', content: 'fix the cache bug' },
      { role: 'user', harness: true, content: '(your reasoning was repeating the same text)' },
      { role: 'user', content: '(a real prompt that happens to start with a paren)' },
    ];
    const r = exciseSpiral(history, { shingles: [] });
    expect(r.droppedNudges).toBe(1);
    expect(r.history).toHaveLength(2);
    expect(r.history.every(m => m.role === 'user' && !m.harness)).toBe(true);
  });

  it('does not mutate the history it was given', () => {
    const round = assistant({
      reasoning: RUT_TEXT,
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    });
    const history: Message[] = [round, { role: 'tool', callId: 'c1', summary: 's', payload: 'p' }];
    const snapshot = JSON.stringify(history);
    exciseSpiral(history, { shingles: RUT, loopingReads: ['a.ts'] });
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

describe('buildAppliedLedger', () => {
  const editRound = (id: string, path: string, name: 'edit' | 'write' = 'edit'): Message =>
    assistant({ toolCalls: [{ id, name, args: { path } }] });
  const diffResult = (callId: string, path: string, added: number, removed: number): Message => ({
    role: 'tool',
    callId,
    summary: `edited ${path}`,
    diff: { text: '', path, added, removed },
  });

  it('reports a file the turn actually wrote', () => {
    const r = buildAppliedLedger([editRound('e1', 'x.ts'), diffResult('e1', 'x.ts', 3, 1)]);
    expect(r).toEqual([{ path: 'x.ts', kind: 'edit', edits: 1, added: 3, removed: 1 }]);
  });

  // The failure this whole function exists to prevent: a re-prompted model believing it already
  // made a change it never made. An edit that produced no diff never landed.
  it('ignores an edit call whose result carried no diff', () => {
    const r = buildAppliedLedger([
      editRound('e1', 'x.ts'),
      { role: 'tool', callId: 'e1', summary: 'edit failed: old_string not found' },
    ]);
    expect(r).toEqual([]);
  });

  it('ignores non-edit tool calls entirely', () => {
    const r = buildAppliedLedger([
      assistant({ toolCalls: [{ id: 'r1', name: 'read', args: { path: 'x.ts' } }] }),
      { role: 'tool', callId: 'r1', summary: 'read x.ts', payload: 'bytes' },
    ]);
    expect(r).toEqual([]);
  });

  it('aggregates repeated edits to one path', () => {
    const r = buildAppliedLedger([
      editRound('e1', 'x.ts'),
      diffResult('e1', 'x.ts', 3, 1),
      editRound('e2', 'x.ts'),
      diffResult('e2', 'x.ts', 2, 4),
    ]);
    expect(r).toEqual([{ path: 'x.ts', kind: 'edit', edits: 2, added: 5, removed: 5 }]);
  });

  it('lets a whole-file write outrank an edit on the same path', () => {
    const r = buildAppliedLedger([
      editRound('e1', 'x.ts'),
      diffResult('e1', 'x.ts', 1, 0),
      editRound('w1', 'x.ts', 'write'),
      diffResult('w1', 'x.ts', 9, 9),
    ]);
    expect(r[0].kind).toBe('write');
  });

  it('does not credit a diff to a call it cannot pair with', () => {
    expect(buildAppliedLedger([diffResult('orphan', 'x.ts', 1, 1)])).toEqual([]);
  });
});

describe('formatAppliedLedger', () => {
  it('says nothing at all when nothing landed', () => {
    expect(formatAppliedLedger([])).toBe('');
  });

  it('names each file and tells the model to verify before touching it again', () => {
    const out = formatAppliedLedger([
      { path: 'x.ts', kind: 'edit', edits: 2, added: 5, removed: 5 },
      { path: 'y.ts', kind: 'write', edits: 1, added: 9, removed: 0 },
    ]);
    expect(out).toContain('x.ts (+5/-5, 2 edits)');
    expect(out).toContain('y.ts (+9/-0)');
    expect(out).toContain('ALREADY saved');
    expect(out).toMatch(/do not re-apply/i);
  });
});
