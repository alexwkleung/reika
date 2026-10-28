import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  Question,
  OWN_ANSWER_LABEL,
  fitOptionsToHeight,
  fitQuestionToHeight,
  layoutQuestion,
} from './Question.js';
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
// scrollback (#456). What the user acts on always shows: the own-answer row, and the option the
// cursor is on. The rest of the list gives way, and says how much it gave away (#856).
describe('Question dialog height (#456)', () => {
  const sized = (
    request: QuestionRequest,
    rows: number,
    typing?: { forIndex?: number },
    cols = 60,
    selectedIndex = 0,
  ) => {
    const { lastFrame } = render(
      <Box flexDirection="column" paddingX={1}>
        <Question
          request={request}
          selectedIndex={selectedIndex}
          typing={typing}
          width={cols}
          rows={rows}
        />
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
    const cases: [QuestionRequest, number, { forIndex?: number } | undefined, number?][] = [
      [tall, 80, undefined],
      [tall, 30, undefined],
      [{ ...tall, question: 'Which one?' }, 30, undefined],
      [tall, 20, {}],
      [tall, 40, { forIndex: 2 }],
      [req, 30, undefined],
      // A windowed list: the height has to follow the window, or App leaves the input too much
      // room and the frame overruns the pane with the options' own rows.
      [tall, 24, undefined, 40],
      [tall, 22, undefined, 80],
    ];
    for (const [request, rows, typing, cols = 60] of cases) {
      for (const selectedIndex of [0, request.options.length]) {
        const drawn = sized(request, rows, typing, cols, selectedIndex).length;
        expect(
          layoutQuestion(request, typing ?? null, cols, rows, 0, selectedIndex).height,
          `${cols}x${rows} sel=${selectedIndex}`,
        ).toBe(drawn);
      }
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

  // #842: on a small pane the option labels wrap and the hint takes two or three rows, so the
  // dialog's own chrome is taller than the fixed row count assumed — and the frame has to stay
  // under the viewport, or Ink repaints the terminal and the scrollback goes with it.
  it('keeps the frame under a narrow viewport, wraps and all', () => {
    const drawn = (cols: number, rows: number): string[] => {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1}>
          <Question request={tall} selectedIndex={0} width={cols} rows={rows} />
        </Box>,
      );
      return stripAnsi(lastFrame() ?? '').split('\n');
    };
    // Every pane the whole list fits in. Below that the labels alone outgrow the pane and the list
    // is windowed — the case after this one.
    for (const [cols, rows] of [
      [100, 40],
      [100, 24],
      [60, 40],
      [50, 40],
      [40, 40],
    ]) {
      const height = layoutQuestion(tall, null, cols, rows, 0).height;
      // The input box and the status bar underneath still have to fit …
      expect(height, `${cols}x${rows}`).toBeLessThanOrEqual(rows - 1 - 6);
      // … and the layout never claims fewer rows than it draws: App sizes the input's window off
      // that claim, so an under-count is what pushes the frame past the viewport.
      expect(drawn(cols, rows).length, `${cols}x${rows}`).toBeLessThanOrEqual(height);
      for (const n of [1, 2, 3, 4]) expect(drawn(cols, rows).join('\n')).toContain(`${n}: `);
      expect(drawn(cols, rows).join('\n')).toContain('Something else');
    }
  });

  // #856: a pane shorter than the options alone. The dialog is at its floor — no descriptions, one
  // row of question and its "more lines" note — and the option list is windowed, because drawing
  // every label is what reaches the viewport height and repaints the terminal.
  it('windows the options when the option rows alone outgrow the pane', () => {
    const tight = layoutQuestion(tall, null, 40, 24, 0);
    expect(tight.fit).toEqual({ showDescriptions: false, questionRows: 1 });
    expect(tight.hiddenQuestionRows).toBe(11);
    // Only the selected option is left with a row to spare; the other three are a marker.
    expect(tight.options).toMatchObject({ start: 0, end: 1, moreAbove: 0, moreBelow: 3 });
    expect(tight.height).toBeLessThanOrEqual(24 - 1 - 6);
  });

  // The window follows the cursor — including the 1-9 keys, which jump to a row that need not be
  // in the window at all, and the own-answer row, which sits past the last option.
  it('keeps the selected option in the window', () => {
    for (const [cols, rows] of [
      [40, 24],
      [80, 22],
      [60, 21],
    ]) {
      for (let selectedIndex = 0; selectedIndex <= tall.options.length; selectedIndex++) {
        const at = `${cols}x${rows} sel=${selectedIndex}`;
        const win = layoutQuestion(tall, null, cols, rows, 0, selectedIndex).options;
        if (!win) throw new Error(`no option window at ${at}`);
        // The own-answer row is index `options.length`: with it selected the window shows the end
        // of the list, since the row the cursor is on is the one under the marker.
        const last = Math.min(selectedIndex, tall.options.length - 1);
        expect(win.start <= last && last < win.end, at).toBe(true);
        // A window that hides something says so, and the rows it reports hold every row it draws.
        expect(win.rows, at).toBeGreaterThanOrEqual(
          win.end - win.start + (win.moreAbove > 0 ? 1 : 0) + (win.moreBelow > 0 ? 1 : 0),
        );
      }
    }
  });

  // Nothing about the list's identity may change with the window: the numbers are the options'
  // own (the 1-9 keys index them), and the escape hatch stays last.
  it('numbers a windowed list by the real option index', () => {
    const out = sized(tall, 24, undefined, 40, 3).join('\n');
    expect(out).toContain('4: Keep');
    expect(out).not.toContain('1: Keep');
    expect(out).toMatch(/↑ 3 more/);
    expect(out).not.toMatch(/↓ \d+ more/);
    // The own-answer row always shows, at its own number, even when options are hidden.
    expect(out).toMatch(/5\. Something else/);
  });

  // The whole list still shows whenever it fits, and there is nothing to mark up.
  it('never windows a list that fits', () => {
    for (const [cols, rows] of [
      [100, 40],
      [40, 40],
      [60, 30],
    ]) {
      const at = `${cols}x${rows}`;
      const win = layoutQuestion(tall, null, cols, rows, 0, 0).options;
      if (!win) throw new Error(`no option window at ${at}`);
      expect({ ...win, rows: 0 }, at).toEqual({
        start: 0,
        end: 4,
        moreAbove: 0,
        moreBelow: 0,
        rows: 0,
      });
      expect(sized(tall, rows, undefined, cols).join('\n')).not.toMatch(/[↑↓] \d+ more/);
    }
  });

  // The hint is the one block nothing else depends on, so a pane that cannot hold it and the
  // question it is asking drops the hint rather than cutting the question.
  it('gives the hint up before the question on a narrow pane', () => {
    expect(layoutQuestion(req, null, 40, 40, 0).showHint).toBe(true);
    const tight = layoutQuestion(req, null, 40, 22, 0);
    expect(tight.showHint).toBe(false);
    expect(tight.fit.questionRows).toBe(2);
  });

  // A question too long to show whole even without the hint, on a pane where the cut question's
  // first row and its note overrun the budget by a row: keeping the hint there is the repaint.
  it('drops the hint when keeping it is what overflows the frame', () => {
    const long: QuestionRequest = {
      question: Array.from({ length: 12 }, (_, i) => `Line ${i} of a long question.`).join('\n'),
      options: [{ label: 'pnpm, since the lockfile is pnpm-lock.yaml' }, { label: 'npm' }],
    };
    for (const [cols, rows] of [
      [40, 21],
      [40, 23],
      [60, 19],
      [60, 21],
    ]) {
      const fitted = layoutQuestion(long, null, cols, rows, 0);
      expect(fitted.showHint, `${cols}x${rows}`).toBe(false);
      expect(fitted.height, `${cols}x${rows}`).toBeLessThanOrEqual(rows - 1 - 6);
      expect(fitted.hiddenQuestionRows, `${cols}x${rows}`).toBeGreaterThan(0);
    }
  });

  it('gives things up in order', () => {
    expect(fitQuestionToHeight(2, 6, 4, 12)).toEqual({ showDescriptions: true, questionRows: 2 });
    expect(fitQuestionToHeight(2, 6, 4, 10)).toEqual({ showDescriptions: false, questionRows: 2 });
    expect(fitQuestionToHeight(8, 6, 4, 10)).toEqual({ showDescriptions: false, questionRows: 3 });
    expect(fitQuestionToHeight(8, 12, 4, 10)).toEqual({ showDescriptions: false, questionRows: 1 });
  });
});

// #856: the window itself, without a terminal in the way.
describe('option window (#856)', () => {
  it('shows the whole list when it fits, and marks nothing', () => {
    expect(fitOptionsToHeight([1, 1, 1], 3, 1)).toEqual({
      start: 0,
      end: 3,
      moreAbove: 0,
      moreBelow: 0,
      rows: 3,
    });
    expect(fitOptionsToHeight([], 0, 0)).toEqual({
      start: 0,
      end: 0,
      moreAbove: 0,
      moreBelow: 0,
      rows: 0,
    });
  });

  // The markers come out of the same budget: three options in five rows keep one above and one
  // below the selection and spend two rows saying so.
  it('pays for its markers out of the budget it is given', () => {
    const win = fitOptionsToHeight([1, 1, 1, 1, 1], 5, 2);
    expect(win.end - win.start + (win.moreAbove > 0 ? 1 : 0) + (win.moreBelow > 0 ? 1 : 0)).toBe(
      win.rows,
    );
    expect(win.rows).toBeLessThanOrEqual(5);
    expect(win.start <= 2 && 2 < win.end).toBe(true);
  });

  it('follows the selection to either end of the list', () => {
    const costs = [1, 1, 1, 1, 1, 1];
    const first = fitOptionsToHeight(costs, 4, 0);
    expect(first).toMatchObject({ start: 0, end: 3, moreAbove: 0, moreBelow: 3 });
    const last = fitOptionsToHeight(costs, 4, 5);
    expect(last).toMatchObject({ start: 3, end: 6, moreAbove: 3, moreBelow: 0 });
  });

  // The 1-9 keys can land on a row that is not in the window, and the own-answer row sits past the
  // last option, so the window is recomputed from whatever the cursor says.
  it('clamps a selection past the last option onto the end of the list', () => {
    const win = fitOptionsToHeight([1, 1, 1, 1], 3, 4);
    expect(win).toMatchObject({ end: 4, moreBelow: 0 });
    // Two options and the "above" marker, not one option and two markers: a marker the window
    // turns out not to need is a row the window gets back.
    expect(win).toMatchObject({ start: 2, end: 4, moreAbove: 2 });
    expect(win.rows).toBe(3);
  });

  // Nothing smaller to draw: a row taller than the whole budget still shows, because hiding it
  // would hide the row the cursor is on.
  it('keeps the selected row even when it alone overruns the budget', () => {
    const win = fitOptionsToHeight([4, 4, 4], 2, 1);
    // The cursor's row and both markers: over the budget by more than the markers cost, so the
    // window says the list is longer than the one row it can draw rather than going quiet.
    expect(win).toMatchObject({ start: 1, end: 2, moreAbove: 1, moreBelow: 1 });
    expect(win.rows).toBe(6);
  });
});
