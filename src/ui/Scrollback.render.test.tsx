import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Scrollback } from './Scrollback.js';
import type { Message } from '../types.js';

// Regression: a tool-call label rendered as two adjacent <Text> siblings in a row
// dropped the boundary character when the line wrapped (long edit args), so
// "• Edit(…)" printed as "• Edi(…)". The label is now a single <Text> with nested
// colored runs, which wraps as one string and keeps every character.
describe('Scrollback tool-call label', () => {
  it('keeps the full tool name when long args force the line to wrap', () => {
    const longCss =
      '.kana-model-select {\n  flex: 1;\n  min-width: 0;\n  max-width: 200px;\n' +
      '  width: 200px;\n  appearance: none;\n  background: var(--surface);\n}';
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 't1',
            name: 'edit',
            args: { path: 'packages/ui/src/styles.css', old_string: longCss, new_string: longCss },
          },
        ],
      },
    ];

    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('• Edit(');
    expect(frame).not.toMatch(/• Edi\(/);
  });

  it('keeps the "↳ " prefix intact when a long tool summary wraps', () => {
    const summary =
      'Edit failed: old_string not found in packages/ui/src/styles.css. Closest match ' +
      'starts at line 378 (".kana-model-select {") but line 379 differs: expected ' +
      '"flex: 1;", file has "font: inherit;". Re-read there and copy verbatim.';
    const messages: Message[] = [{ role: 'tool', callId: 't1', summary }];

    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('↳ Edit failed:');
    expect(frame).not.toMatch(/↳Edit failed:/);
  });
});
