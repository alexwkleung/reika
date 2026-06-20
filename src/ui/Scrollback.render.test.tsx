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
    // Use a tool whose args still render in full (bash) so the line actually
    // wraps — edit/write now hide their bulky body args, so they no longer do.
    const longCmd = `echo ${'lorem ipsum dolor sit amet '.repeat(8).trim()}`;
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'bash', args: { command: longCmd } }],
      },
    ];

    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('• Bash(');
    expect(frame).not.toMatch(/• Bas\(/);
  });

  it('hides an edit’s old_string/new_string but keeps the path', () => {
    const longCss = '.kana-model-select {\n  flex: 1;\n  min-width: 0;\n}';
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

    expect(frame).toContain('• Edit(path="packages/ui/src/styles.css")');
    expect(frame).not.toContain('old_string');
    expect(frame).not.toContain('new_string');
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

describe('Scrollback system-message tone', () => {
  const frameFor = (msg: Message): string => {
    const { lastFrame } = render(
      <Scrollback messages={[msg]} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return lastFrame() ?? '';
  };

  it('marks a warn notice (truncation retry) with the recycle glyph', () => {
    const frame = frameFor({
      role: 'system',
      tone: 'warn',
      content: 'Response cut off — retrying.',
    });
    expect(frame).toContain('⟳ Response cut off');
    expect(frame).not.toContain('❯');
  });

  it('marks info and default notices with the caret (not the warn glyph)', () => {
    expect(frameFor({ role: 'system', tone: 'info', content: 'Context compacted.' })).toContain(
      '❯ Context compacted.',
    );
    expect(frameFor({ role: 'system', content: 'plain note' })).toContain('❯ plain note');
  });
});

// Regression: Ink repaints the whole terminal — emitting `\x1b[3J`, which clears
// native scrollback (iTerm2: "a control sequence attempted to clear scrollback") —
// whenever the live frame is at least as tall as the viewport (build/ink.js:
// `outputHeight >= stdout.rows`). On a long stream that repaint fires every frame,
// producing the scroll-lock / jitter / duplicated-terminal behavior. The live blocks
// must therefore stay bounded in *wrapped display rows*, not logical lines.
describe('Scrollback live-region height', () => {
  const setViewport = (rows: number, columns: number) => {
    const prev = { rows: process.stdout.rows, columns: process.stdout.columns };
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    return () =>
      Object.defineProperties(process.stdout, {
        rows: { value: prev.rows, configurable: true },
        columns: { value: prev.columns, configurable: true },
      });
  };

  it('keeps a huge streamed payload under the viewport height', () => {
    const restore = setViewport(30, 60);
    try {
      // 2000 logical lines, many of them long enough to wrap several times — the
      // pre-fix code (bounding logical lines, then letting markdown + Ink wrap)
      // would blow far past 30 rows.
      const huge = Array.from(
        { length: 2000 },
        (_, i) => `Line ${i}: ${'lorem ipsum '.repeat(8)}`,
      ).join('\n');
      const { lastFrame } = render(
        <Scrollback messages={[]} streaming={huge} streamingReasoning="" streamingTool="" />,
      );
      const height = (lastFrame() ?? '').split('\n').length;
      expect(height).toBeLessThan(process.stdout.rows);
    } finally {
      restore();
    }
  });

  it('bounds reasoning + content + tool blocks together under the viewport', () => {
    const restore = setViewport(30, 60);
    try {
      const big = (tag: string) =>
        Array.from({ length: 500 }, (_, i) => `${tag} ${i}: ${'word '.repeat(12)}`).join('\n');
      const { lastFrame } = render(
        <Scrollback
          messages={[]}
          streaming={big('content')}
          streamingReasoning={big('think')}
          streamingTool={big('tool')}
        />,
      );
      const height = (lastFrame() ?? '').split('\n').length;
      expect(height).toBeLessThan(process.stdout.rows);
    } finally {
      restore();
    }
  });
});
