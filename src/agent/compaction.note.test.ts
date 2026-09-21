import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { compactHistory } from './compaction.js';
import {
  COMPACTION_NOTE_MAX_CHARS,
  buildCompactionReportDirective,
  clampCompactionNote,
  compactionNoteHeader,
} from './compactionreport.js';

// #280: a compaction note — the model's own findings, written on the report round — leads the recap
// and supersedes the prior fold's narrative. The read ledger still follows it.

function turn(n: number, file: string): Message[] {
  return [
    { role: 'user', content: `q${n}` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${n}`, name: 'read', args: { path: file } }],
    },
    { role: 'tool', callId: `c${n}`, summary: `read ${file}`, payload: 'X'.repeat(500) },
    // Long enough that eight turns exceed the keep budget (only summaries and content are priced).
    { role: 'assistant', content: `answer${n} ` + 'y'.repeat(300) },
  ];
}
// Big enough that the recap budget (RECAP_FRACTION of the window) has room for a note header plus
// a few hundred chars of body; eight tiny turns exceed the keep budget and force the fold.
const W = 1500;
// The opening user message is pinned at index 0; the recap follows it (or leads when the history
// opens with a prior recap).
const recapOf = (h: Message[]): string =>
  (h.find(m => m.role === 'compaction') as { content: string }).content;

describe('compactHistory with a compaction note (#280)', () => {
  it('leads the recap with the note under its own-words header, ledger after', () => {
    const history: Message[] = [...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => turn(n, `f${n}.ts`))];
    const removed = compactHistory(history, W, 1, 0, {
      n: 1,
      text: 'Gate is bashTool.run in src/tools/bash.ts; decline string is `Bash declined by user`.',
    });
    expect(removed).toBeGreaterThan(0);
    const recap = recapOf(history);
    const headerAt = recap.indexOf(compactionNoteHeader(1));
    expect(headerAt).toBeGreaterThan(-1);
    expect(recap).toContain('bashTool.run in src/tools/bash.ts');
    // The note precedes the ledger material.
    const ledgerAt = recap.search(/read f\d\.ts|Tools used|Files touched/);
    expect(ledgerAt).toBeGreaterThan(headerAt);
  });

  it('supersedes a prior recap instead of stacking it', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'PRIOR RECAP NARRATIVE' },
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => turn(n, `f${n}.ts`)),
    ];
    compactHistory(history, W, 1, 0, { n: 2, text: 'carried: the gate; open: the UI handler' });
    const recap = recapOf(history);
    expect(recap).toContain(compactionNoteHeader(2));
    expect(recap).toContain('carried: the gate');
    expect(recap).not.toContain('PRIOR RECAP NARRATIVE');
  });

  it('still carries a prior recap when there is no note (unchanged behaviour)', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'PRIOR RECAP NARRATIVE' },
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => turn(n, `f${n}.ts`)),
    ];
    compactHistory(history, W, 1, 0);
    expect(recapOf(history)).toContain('PRIOR RECAP NARRATIVE');
  });

  // Fitted from the front: the model leads with what it established, and the header must survive.
  it('trims an oversized note from the end, keeping the header', () => {
    const history: Message[] = [...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => turn(n, `f${n}.ts`))];
    const text = 'START ' + 'finding. '.repeat(400) + ' END';
    compactHistory(history, W, 1, 0, { n: 1, text });
    const recap = recapOf(history);
    expect(recap).toContain(compactionNoteHeader(1));
    expect(recap).toContain('START finding.');
    expect(recap).not.toContain(' END');
    expect(recap).toContain('…');
  });
});

describe('compaction report directive + clamp', () => {
  it('numbers the note, withdraws tools, asks for findings and what is open, forbids answering', () => {
    const d = buildCompactionReportDirective(3);
    expect(d).toContain('note 3 of this session');
    expect(d).toContain('Tools are withdrawn');
    expect(d).toContain('file paths and function names');
    expect(d).toContain('what is still open');
    expect(d).toContain('Do not answer the task');
  });

  it('clamps a runaway note at the hard cap', () => {
    const long = 'x'.repeat(COMPACTION_NOTE_MAX_CHARS * 2);
    const c = clampCompactionNote(long);
    expect(c.length).toBe(COMPACTION_NOTE_MAX_CHARS);
    expect(c.endsWith('…')).toBe(true);
    expect(clampCompactionNote('  short  ')).toBe('short');
  });

  it('says whose words the note is', () => {
    expect(compactionNoteHeader(1)).toContain('written by you');
    expect(compactionNoteHeader(1)).toContain('not tool output');
  });
});
