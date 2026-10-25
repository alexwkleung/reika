import { describe, expect, it } from 'vitest';
import {
  COMPACTION_CALL_REFUSED,
  compactionNoteContent,
  pickCompactionNote,
  refusedCallTurn,
} from './compactionreport.js';

const call = [{ id: 'x', name: 'read', args: {} }];

describe('compactionNoteContent', () => {
  it('takes the content of a call-free reply', () => {
    expect(compactionNoteContent({ content: '  Established: a. Open: b.  ' })).toBe(
      'Established: a. Open: b.',
    );
  });

  it('treats the content of a reply that made a call as no note (#799)', () => {
    expect(
      compactionNoteContent({ content: 'Let me examine `_net.ts` in detail:', toolCalls: call }),
    ).toBe('');
  });
});

describe('pickCompactionNote', () => {
  // The observed shape: both replies called a tool, the retry's content was the call's preamble and
  // its reasoning held the findings.
  it('falls back to the longer reasoning when both replies made a call (#799)', () => {
    const findings = 'Need to change the failed branch in headless.ts; '.repeat(10);
    const picked = pickCompactionNote(
      { content: '', reasoning: 'Let me look.', toolCalls: call },
      { content: 'Let me examine `_net.ts` in detail:', reasoning: findings, toolCalls: call },
    );
    expect(picked.src).toBe('reasoning');
    expect(picked.text).toBe(findings.trim());
  });

  it('prefers the first reasoning when it is the longer one', () => {
    const picked = pickCompactionNote(
      { content: '', reasoning: 'reasoned note' },
      { content: '', reasoning: 'second' },
    );
    expect(picked).toEqual({ text: 'reasoned note', src: 'reasoning' });
  });

  it('takes content from a call-free reply over any reasoning', () => {
    const picked = pickCompactionNote(
      { content: 'preamble', reasoning: 'x'.repeat(500), toolCalls: call },
      { content: 'RETRY NOTE', reasoning: 'short' },
    );
    expect(picked).toEqual({ text: 'RETRY NOTE', reasoning: 'short', src: 'content' });
  });

  it('reports empty when neither reply carries anything', () => {
    expect(pickCompactionNote({ content: '' }, { content: '  ' })).toEqual({
      text: '',
      src: 'empty',
    });
  });
});

describe('refusedCallTurn (#806)', () => {
  it('answers each call the note reply made with a refusal, after the reply itself', () => {
    const calls = [
      { id: 'a', name: 'read', args: { path: 'x.ts' } },
      { id: 'b', name: 'bash', args: { command: 'cat y.ts' } },
    ];
    expect(refusedCallTurn({ content: 'Let me look:', reasoning: 'r', toolCalls: calls })).toEqual([
      { role: 'assistant', content: 'Let me look:', reasoning: 'r', toolCalls: calls },
      { role: 'tool', callId: 'a', summary: COMPACTION_CALL_REFUSED },
      { role: 'tool', callId: 'b', summary: COMPACTION_CALL_REFUSED },
    ]);
  });

  it('appends nothing for a reply that made no call', () => {
    expect(refusedCallTurn({ content: '', reasoning: 'thinking' })).toEqual([]);
    expect(refusedCallTurn({ content: '', toolCalls: [] })).toEqual([]);
  });
});
