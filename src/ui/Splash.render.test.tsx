import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box, Static } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { Splash } from './Splash.js';

// Issue #154, third surface. The splash's cwd is a label-and-value ROW rendered inside
// <Static> — where Ink lays a row out at its children's intrinsic width and lets it overflow
// rather than wrapping it. A deep cwd therefore ran off the right edge and the TERMINAL broke it,
// mid-path, at column 0 of the next line: the one ragged row in an otherwise aligned block. An
// explicit width puts the wrap back under Ink, which breaks it under the value column instead.
const DEEP_CWD =
  '~/Projects/acme-platform/services/checkout/packages/worker-runtime/src/handlers/webhooks/stripe';

// The app shell: everything renders inside the App's paddingX={1}, and scrollback lives in Static.
function inShell(node: React.ReactElement): string[] {
  const { lastFrame } = render(
    <Box flexDirection="column" paddingX={1}>
      <Static items={['one']}>{k => <Box key={k}>{node}</Box>}</Static>
    </Box>,
  );
  return (lastFrame() ?? '').split('\n');
}

const width = (): number => process.stdout.columns || 100;

describe('Splash width', () => {
  it('wraps a deep cwd inside the terminal instead of overflowing the row', () => {
    const rows = inShell(<Splash model="qwen3-coder-30b" cwd={DEEP_CWD} version="0.0.1" />);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(width());
  });

  it('breaks the wrapped cwd under the value column, not at the margin', () => {
    const rows = inShell(<Splash model="qwen3-coder-30b" cwd={DEEP_CWD} version="0.0.1" />);
    const first = rows.findIndex(r => r.includes('cwd:'));
    expect(first).toBeGreaterThanOrEqual(0);
    const valueCol = rows[first].indexOf('~/Projects');
    const continuation = rows[first + 1];
    // Ink's own wrap keeps the hanging indent; a terminal wrap would start at column 0.
    expect(continuation.slice(0, valueCol).trim()).toBe('');
    expect(continuation.trim().length).toBeGreaterThan(0);
  });
});
