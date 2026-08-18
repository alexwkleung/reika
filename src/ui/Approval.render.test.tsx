import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import React from 'react';
import chalk from 'chalk';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { Approval } from './Approval.js';
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
});
