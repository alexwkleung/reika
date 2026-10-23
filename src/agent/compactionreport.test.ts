import { describe, expect, it } from 'vitest';
import { compactionNoteContent, pickCompactionNote } from './compactionreport.js';

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
