import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Question, OWN_ANSWER_LABEL, fitQuestionToHeight, layoutQuestion } from './Question.js';
import { clampToViewport } from './Input.js';
import { restoreTextPresentation } from './syncframe.js';
import type { QuestionRequest } from '../types.js';

const frame = (
  request: QuestionRequest,
  selectedIndex = 0,
  typing?: { forIndex?: number } | null,
): string => {
  const { lastFrame } = render(
    <Box flexDirection="column" paddingX={1}>
      <Question request={request} selectedIndex={selectedIndex} typing={typing} />
    </Box>,
  );
  return stripAnsi(lastFrame() ?? '');
};

const req: QuestionRequest = {
  question: 'Flag every interpreter, or only inline bodies?',
  options: [
    {
      label: 'Flag only inline bodies',
      description: 'Keeps python3 script.py silent',
      recommended: true,
    },
    { label: 'Flag every interpreter invocation' },
  ],
};

describe('Question dialog', () => {
  // Same check as Approval's: counted on the bytes the terminal receives, after the stream puts
  // the marker's VS15 back, the title row must end where every other bordered row does.
  it('keeps the right border in one column on the title row (#494)', () => {
    const drawn = (row: string): number => [...row.replace(/\uFE0E/g, '')].length;
    const bordered = frame(req)
      .split('\n')
      .filter(r => r.trim().startsWith('│'))
      .map(restoreTextPresentation);
    expect(bordered.some(r => r.includes('\u23FA\uFE0E Question'))).toBe(true);
    for (const row of bordered) expect(drawn(row)).toBe(drawn(bordered[0]));
  });

  it('shows the question, the options, and their descriptions', () => {
    const out = frame(req);
    expect(out).toContain('Flag every interpreter, or only inline bodies?');
    expect(out).toContain('Flag only inline bodies');
    expect(out).toContain('Keeps python3 script.py silent');
    expect(out).toContain('(recommended)');
  });

  // The escape hatch for "all of these options are wrong" — it is what makes a menu safe to show a
  // model that may have framed the question badly, so it must always be there.
  it('always offers the type-your-own row after the last option', () => {
    const out = frame(req);
    expect(out).toContain(OWN_ANSWER_LABEL);
    expect(out.indexOf(OWN_ANSWER_LABEL)).toBeGreaterThan(
      out.indexOf('Flag every interpreter invocation'),
    );
  });

  it('marks the selected row, including the type-your-own row', () => {
    expect(frame(req, 0)).toMatch(/›\s+1\. Flag only inline bodies/);
    expect(frame(req, req.options.length)).toMatch(new RegExp(`›\\s+3\\. ${OWN_ANSWER_LABEL}`));
  });

  // Four full-sentence labels with indented descriptions read as one paragraph without a number
  // anchoring each entry; the description sits under the label text, not under the number.
  it('numbers every row contiguously and indents descriptions under the label', () => {
    const out = frame(req, 1);
    const lines = out.split('\n');
    const label = lines.findIndex(l => l.includes('1. Flag only inline bodies'));
    expect(label).toBeGreaterThan(-1);
    expect(lines[label + 1].indexOf('Keeps python3')).toBe(lines[label].indexOf('Flag only'));
    expect(out).toMatch(/2\. Flag every interpreter invocation/);
    expect(out).toMatch(/3\. Something else/);
    expect(out).toContain('1-9 navigate');
  });

  // Ink has no hanging indent: a wrapped label's second row would otherwise land flush left,
  // detached from its number. The `(recommended)` tag rides the same wrap so it can't be pushed
  // onto a flush-left row of its own.
  it('wraps long labels and descriptions under the label text, not the marker', () => {
    const long: QuestionRequest = {
      question: 'q?',
      options: [
        {
          label:
            'Everything above Quick start: tagline, Why, The Challenge, Status, Note, and Tested Models',
          description:
            'The narrowest reading — rewrite the pitch paragraph and nothing else, leaving every section below it as it is.',
          recommended: true,
        },
        { label: 'B' },
      ],
    };
    const { lastFrame } = render(
      <Box flexDirection="column" paddingX={1}>
        <Question request={long} selectedIndex={0} width={50} />
      </Box>,
    );
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const first = lines.findIndex(l => l.includes('1. Everything'));
    const col = lines[first].indexOf('Everything');
    // First non-blank column past the dialog's left border.
    const startCol = (l: string) => l.indexOf('│') + 1 + l.slice(l.indexOf('│') + 1).search(/\S/);
    expect(first).toBeGreaterThan(-1);
    // Every row between the first label row and option 2 is a continuation or the description,
    // and all of them start at the label's column.
    const second = lines.findIndex(l => l.includes('2. B'));
    expect(second - first).toBeGreaterThan(2);
    for (const l of lines.slice(first + 1, second)) {
      expect(startCol(l)).toBe(col);
    }
    expect(lines.slice(first, second).join('\n')).toContain('(recommended)');
  });

  it('renders an option with no description', () => {
    const out = frame({ question: 'q?', options: [{ label: 'A' }, { label: 'B' }] });
    expect(out).toContain('A');
    expect(out).toContain('B');
  });

  it('replaces the list with a typing prompt once the user types their own answer', () => {
    const out = frame(req, 2, {});
    expect(out).toContain('Type your answer below.');
    expect(out).not.toContain('Flag only inline bodies');
    expect(out).toContain('enter submit');
    // What ctrl-c does in the field is not what it does on the list (#651), so the field says so.
    expect(out).toContain('ctrl-c back to the options');
  });

  it('names the option being annotated when a note is being added', () => {
    const out = frame(req, 0, { forIndex: 0 });
    expect(out).toContain('Adding a note to: Flag only inline bodies');
    expect(out).toContain('ctrl-c back to the options');
  });

  // No escape-to-back either: a split arrow-key sequence delivers a bare escape, and on this dialog
  // that keystroke would answer the question on the user's behalf. Ctrl-c is the only way out — out
  // of the field back to the list, out of the list when it is the list taking the key.
  it('advertises the note key and offers no escape binding', () => {
    const out = frame(req);
    expect(out).toContain('tab add a note');
    expect(out).not.toContain('esc');
    expect(out).toContain('ctrl-c abort');
  });
});

// A frame as tall as the viewport makes Ink repaint with `\x1b[3J` and strands the dialog in the
// scrollback (#456). What the user acts on — every option and the own-answer row — always shows.
describe('Question dialog height (#456)', () => {
  const sized = (request: QuestionRequest, rows: number, typing?: { forIndex?: number }) => {
    const { lastFrame } = render(
      <Box flexDirection="column" paddingX={1}>
        <Question request={request} selectedIndex={0} typing={typing} width={60} rows={rows} />
      </Box>,
    );
    return stripAnsi(lastFrame() ?? '').split('\n');
  };
  const sentence = 'Keep the existing behaviour for scripts but flag inline interpreter bodies';
  const tall: QuestionRequest = {
    question: Array.from({ length: 12 }, (_, i) => `Context line ${i + 1}.`).join('\n'),
    options: [1, 2, 3, 4].map(n => ({
      label: `${n}: ${sentence}`,
      description: `Description ${n}: ${sentence}`,
    })),
  };

  it('drops descriptions before anything else', () => {
    const request = { ...tall, question: 'Which one?' };
    const rows = sized(request, 30);
    expect(rows.length).toBeLessThanOrEqual(30 - 6);
    expect(rows.join('\n')).not.toContain('Description 1');
    for (const n of [1, 2, 3, 4]) expect(rows.join('\n')).toContain(`${n}: Keep`);
    expect(rows.join('\n')).toContain('Something else');
  });

  it('then cuts the question tail, keeping every option', () => {
    const rows = sized(tall, 30);
    const out = rows.join('\n');
    expect(rows.length).toBeLessThanOrEqual(30 - 6);
    expect(out).toContain('Context line 1.');
    expect(out).not.toContain('Context line 12.');
    expect(out).toMatch(/… \d+ more lines/);
    for (const n of [1, 2, 3, 4]) expect(out).toContain(`${n}: Keep`);
    expect(out).toContain('Something else');
  });

  it('bounds the question while typing an answer too', () => {
    const rows = sized(tall, 20, {});
    expect(rows.length).toBeLessThanOrEqual(20 - 6);
    expect(rows.join('\n')).toContain('Type your answer below.');
  });

  it('leaves a question that fits untouched', () => {
    const out = sized(tall, 80).join('\n');
    expect(out).toContain('Context line 12.');
    expect(out).toContain('Description 4');
    expect(out).not.toContain('more lines');
  });

  // App sizes the input's window off this number, so it has to be what the dialog draws.
  it('reports the height it renders', () => {
    const cases: [QuestionRequest, number, { forIndex?: number } | undefined][] = [
      [tall, 80, undefined],
      [tall, 30, undefined],
      [{ ...tall, question: 'Which one?' }, 30, undefined],
      [tall, 20, {}],
      [tall, 40, { forIndex: 2 }],
      [req, 30, undefined],
    ];
    for (const [request, rows, typing] of cases) {
      const drawn = sized(request, rows, typing).length;
      expect(layoutQuestion(request, typing ?? null, 60, rows, 0).height).toBe(drawn);
    }
  });

  // The input under a typing-mode question scrolls its window instead of growing past the frame:
  // with a question at its full budget and a 40-line answer, dialog + input + status still fit.
  it('leaves the answer box room to scroll instead of overflowing', () => {
    const answer = Array.from({ length: 40 }, (_, i) => `answer line ${i + 1}`).join('\n');
    for (const rows of [20, 30, 50]) {
      const dialog = layoutQuestion(tall, {}, 60, rows, 0).height;
      const view = clampToViewport(answer, answer.length, rows - dialog);
      const inputRows = view.text.split('\n').length + 1; // + bottom border
      const status = 2;
      expect(dialog + inputRows + status).toBeLessThan(rows);
    }
  });

  it('gives things up in order', () => {
    expect(fitQuestionToHeight(2, 6, 4, 12)).toEqual({ showDescriptions: true, questionRows: 2 });
    expect(fitQuestionToHeight(2, 6, 4, 10)).toEqual({ showDescriptions: false, questionRows: 2 });
    expect(fitQuestionToHeight(8, 6, 4, 10)).toEqual({ showDescriptions: false, questionRows: 3 });
    expect(fitQuestionToHeight(8, 12, 4, 10)).toEqual({ showDescriptions: false, questionRows: 1 });
  });
});
