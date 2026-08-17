import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import React from 'react';
import { Box } from 'ink';
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

// Render one message on its own and return the frame. Shared by the scrub/tone suites below.
const frameFor = (msg: Message): string => {
  const { lastFrame } = render(
    <Scrollback messages={[msg]} streaming="" streamingReasoning="" streamingTool="" />,
  );
  return lastFrame() ?? '';
};

describe('Scrollback system-message tone', () => {
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

  // #138: /save reported the transcript's absolute path, leaking the home directory
  // into scrollback while every tool line beside it was already scrubbed.
  it('collapses $HOME in a notice path (e.g. /save) to ~', () => {
    const file = `${homedir()}/.config/reika/history/t.jsonl`;
    const frame = frameFor({ role: 'system', content: `saved 2 messages → ${file}` });
    expect(frame).toContain('~/.config/reika/history/t.jsonl');
    expect(frame).not.toContain(homedir());
  });

  // Errors quote paths too (fs errno strings), and an error box is the text most
  // likely to be pasted into a bug report — so it gets the same scrub.
  it('collapses $HOME in an error path to ~', () => {
    const frame = frameFor({ role: 'error', content: `save failed: EACCES ${homedir()}/x.jsonl` });
    expect(frame).toContain('save failed: EACCES ~/x.jsonl');
    expect(frame).not.toContain(homedir());
  });
});

// Shell mode ran the same commands as the bash tool through the same terminal but rendered them
// with neither scrubber — so `security find-identity` in /shell printed an identity that the bash
// tool would have redacted, and `pwd` printed the home path every other line collapses. The
// transcript already scrubbed shell messages on save; the UI was the half that hadn't caught up.
describe('Scrollback shell-mode scrubbing', () => {
  it('collapses $HOME in a shell command and its output', () => {
    const frame = frameFor({
      role: 'shell',
      command: `ls ${homedir()}/Downloads`,
      output: `${homedir()}/Downloads/a.dmg`,
    });
    expect(frame).toContain('~/Downloads');
    expect(frame).not.toContain(homedir());
  });

  it('redacts a signing identity in shell output', () => {
    const frame = frameFor({
      role: 'shell',
      command: 'security find-identity -v -p codesigning',
      output: '  1) "Developer ID Application: Jane Dev (AB12CD34EF)"',
    });
    expect(frame).toContain('<redacted>');
    expect(frame).not.toContain('Jane Dev');
    expect(frame).not.toContain('AB12CD34EF');
  });
});

// Regression: subagent messages render under `marginLeft={4}`, but the blocks that
// size themselves off `process.stdout.columns` (user bubble, reasoning bar, diff)
// ignored that indent, so every row was laid out 4 columns wider than its box. Ink
// wrapped the overflow onto a continuation row — visible as the user's prompt broken
// into fragments, some rows carrying the grey background with no accent bar.
describe('Scrollback nested (subagent) messages', () => {
  const COLS = 60;
  const INDENT = 4;

  const framePlusApp = (messages: Message[]): string => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      // Mirror App's own paddingX={1}, which the width math accounts for.
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1} width={COLS}>
          <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />
        </Box>,
      );
      return lastFrame() ?? '';
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  it('keeps every user-bubble row on one line, bar included', () => {
    const frame = framePlusApp([
      {
        role: 'user',
        content: 'Find every call site of parseConfig and report the file and line for each one.',
        nested: true,
      },
    ]);
    const rows = frame.split('\n').filter(l => l.trim());

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(new RegExp(`^ {${1 + INDENT}}▎`));
      expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    }
  });

  it('keeps every reasoning row behind its bar', () => {
    const frame = framePlusApp([
      {
        role: 'assistant',
        content: '',
        reasoning: 'I should look at the config loader before touching any call sites at all.',
        nested: true,
      },
    ]);
    const rows = frame.split('\n').filter(l => l.trim());

    expect(rows.length).toBeGreaterThan(1); // header + at least one wrapped body row
    for (const row of rows) {
      expect(row).toMatch(new RegExp(`^ {${1 + INDENT}}▎`));
      expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    }
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

// The command chip's omission marker. `outputTail` is now the END of a run (tools/bash.ts), so the
// bytes that were dropped came BEFORE it — the marker has to sit above the lines. It used to sit
// below, which read correctly when the chip showed the head and would now be backwards.
describe('Scrollback command chip', () => {
  const chipFrame = (outputTruncated: boolean): string[] => {
    const messages: Message[] = [
      {
        role: 'tool',
        callId: 't1',
        summary: 'Ran: npm test',
        command: { text: 'npm test', outputTail: 'FAIL src/a.test.ts\n1 failed', outputTruncated },
      },
    ];
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return (lastFrame() ?? '').split('\n').map(l => l.trim());
  };

  it('puts the omission marker above the tail, not below it', () => {
    const lines = chipFrame(true);
    const marker = lines.findIndex(l => l.includes('earlier output omitted'));
    const tail = lines.findIndex(l => l.includes('FAIL src/a.test.ts'));
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(tail).toBeGreaterThan(marker);
    expect(lines.join('\n')).not.toContain('more output omitted');
  });

  it('shows no marker when the whole output is on screen', () => {
    const lines = chipFrame(false);
    expect(lines.join('\n')).not.toContain('omitted');
    expect(lines.some(l => l.includes('FAIL src/a.test.ts'))).toBe(true);
  });
});
