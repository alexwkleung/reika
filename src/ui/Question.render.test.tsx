import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Question, OWN_ANSWER_LABEL } from './Question.js';
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
  });

  it('names the option being annotated when a note is being added', () => {
    const out = frame(req, 0, { forIndex: 0 });
    expect(out).toContain('Adding a note to: Flag only inline bodies');
  });

  // No escape-to-skip: a split arrow-key sequence delivers a bare escape, which would answer the
  // question on the user's behalf. Ctrl-c is the only way out, as with Approval.
  it('advertises the note key and offers no escape binding', () => {
    const out = frame(req);
    expect(out).toContain('tab add a note');
    expect(out).not.toContain('esc');
    expect(out).toContain('ctrl-c abort');
  });
});
