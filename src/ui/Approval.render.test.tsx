import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import React from 'react';
import chalk from 'chalk';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { Approval, approvalPreviewRows, fitCommandLines } from './Approval.js';
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
      expect(stringWidth(row)).toBeLessThanOrEqual(width());
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
      expect(stringWidth(row)).toBeLessThanOrEqual(width());
      expect(row.trim().endsWith('│')).toBe(true);
    }
  });

  // string-width alone can't catch #450: it is the measurer that disagreed with the terminal.
  // Counting code points (VS15 aside) is the terminal's view for anything it draws one-wide.
  it('keeps the right border in one column on the title row (#450)', () => {
    const rows = frame({
      tool: 'bash',
      subject: '~/repo',
      preview: 'npx prettier --write src/tools/bash.test.ts',
      warnings: ['Remote package execution (npx/bunx/uvx)'],
    });
    const drawn = (row: string): number => [...row.replace(/︎/g, '')].length;
    const bordered = rows.filter(r => r.trim().startsWith('│'));
    expect(bordered.some(r => r.includes('Bash'))).toBe(true);
    for (const row of bordered) {
      expect(drawn(row)).toBe(stringWidth(row));
      expect(drawn(row)).toBe(drawn(bordered[0]));
    }
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
    expect(approvalPreviewRows(0, 0, 40)).toBe(22);
    expect(approvalPreviewRows(2, 0, 40)).toBe(19);
    expect(approvalPreviewRows(0, 5, 40)).toBe(17);
    expect(approvalPreviewRows(3, 0, 10)).toBe(3);
  });

  it('counts wrapped rows, not lines', () => {
    const long = 'x'.repeat(25);
    // Each line wraps to 3 rows at width 10; 7 rows fit two lines plus the footer.
    expect(fitCommandLines([long, long, long, long], 7, 10)).toEqual({
      lines: [long, long],
      hidden: 2,
    });
    expect(fitCommandLines([long, long], 6, 10)).toEqual({ lines: [long, long], hidden: 0 });
  });
});
