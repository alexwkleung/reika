import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
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

// Issue #154: a command's output is a stream of terminal instructions, not display text. Tabs
// measure 0 for Ink but expand to 8 columns on screen, so a wide line looked narrow, went out
// unwrapped, and the terminal wrapped it at a column Ink knew nothing about — continuation rows
// landing outside the chip's indent, and Ink's row count (which the live-region budget depends on)
// wrong. Carriage returns were worse: they return the cursor to column 0 of the PHYSICAL row and
// paint over the indent. Both are now flattened to what a terminal would have shown.
describe('Scrollback command output sanitizing', () => {
  const TAB = '\t';
  const CR = '\r';
  const ESC = String.fromCharCode(27);

  const frameFor = (outputTail: string, text = 'make build'): string => {
    const messages: Message[] = [
      {
        role: 'tool',
        callId: 't1',
        summary: `Ran: ${text}`,
        command: { text, outputTail, outputTruncated: false },
      },
    ];
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return lastFrame() ?? '';
  };

  it('wraps tab-heavy output inside the frame instead of overflowing it', () => {
    const width = process.stdout.columns || 100;
    const frame = frameFor(`ab${TAB}`.repeat(40));
    expect(frame).not.toContain(TAB);
    for (const line of frame.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps every wrapped row of the output under the chip indent', () => {
    const frame = frameFor(`x${TAB}`.repeat(60));
    const rows = frame.split('\n').filter(l => l.trim().startsWith('x'));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.startsWith('    x')).toBe(true);
  });

  it('resolves progress output written with carriage returns', () => {
    const frame = frameFor(`Downloading 5%${CR}Downloading 100%`);
    expect(frame).not.toContain(CR);
    expect(frame).toContain('Downloading 100%');
    expect(frame).not.toContain('Downloading 5%');
  });

  it('strips escape sequences from the output and from the command line', () => {
    const frame = frameFor(`${ESC}[2Jcleared`, `echo ${ESC}[31mhi`);
    expect(frame).not.toContain(ESC);
    expect(frame).toContain('cleared');
    expect(frame).toContain('echo hi');
  });
});

// Issue #154, second surface: the diff view paints changed lines with a background padded out to
// the available width. The padding was counted in CHARACTERS, so a tab (one character, eight
// columns) or a CJK glyph (one character, two columns) pushed the block past where every other row
// ended — a ragged colored edge, and a wrapped colored stub once it cleared the terminal. Tabs are
// flattened before layout and the padding is measured in columns.
//
// Color is forced on for these: with chalk at level 0 the background escapes disappear and Ink
// trims the padding spaces as trailing whitespace, so the very thing under test isn't in the frame.
describe('Scrollback diff view width', () => {
  const TAB = '\t';
  const width = (): number => process.stdout.columns || 100;

  // What a terminal does with a tab that reached it: advance to the next 8-column stop.
  const expandTabs = (row: string): string => {
    let out = '';
    for (const ch of row) {
      if (ch !== TAB) {
        out += ch;
        continue;
      }
      const stop = (Math.floor(stringWidth(out) / 8) + 1) * 8;
      out += ' '.repeat(stop - stringWidth(out));
    }
    return out;
  };
  let level: typeof chalk.level;

  beforeAll(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = level;
  });

  const diffFrame = (diff: string, path = 'main.go'): string[] => {
    const messages: Message[] = [
      {
        role: 'tool',
        callId: 't1',
        summary: `Edited ${path}`,
        diff: { text: diff, path, added: 1, removed: 1, startLine: 10 },
      },
    ];
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    // Stripped for the assertions below: with color forced on, the highlighter's escapes sit
    // between tokens, so column math and substring matching have to run on the visible text.
    // string-width ignores escapes either way, so the width assertions are unaffected.
    return (lastFrame() ?? '').split('\n').map(stripAnsi);
  };

  it('paints tab-indented changed lines to the same width as every other one', () => {
    const rows = diffFrame(
      [
        `  func handler() {`,
        `- ${TAB}${TAB}log.Printf("old")`,
        `+ ${TAB}${TAB}log.Printf("new value")`,
        `  ${TAB}}`,
      ].join('\n'),
    );
    const changed = rows.filter(r => r.includes('log.Printf'));
    expect(changed).toHaveLength(2);
    // Different content lengths, one painted width: that is the padding doing its job.
    expect(new Set(changed.map(r => stringWidth(r))).size).toBe(1);
    expect(rows.join('\n')).not.toContain(TAB);
  });

  it('keeps a deeply tab-indented changed line inside the terminal width', () => {
    const width = process.stdout.columns || 100;
    const rows = diffFrame([`  ok`, `+ ${TAB}${TAB}${TAB}deeply := "indented"`].join('\n'));
    // Measured the way the SCREEN sees it — a raw tab left in the frame is zero columns to
    // string-width and eight to the terminal, which is the whole bug; measuring the frame as-is
    // would report every over-wide row as fitting.
    for (const row of rows) expect(stringWidth(expandTabs(row))).toBeLessThanOrEqual(width);
  });

  // Nearly a fifth of the lines in this repo are wider than the diff area at 80 columns. Ink lays
  // a diff row out at its intrinsic width and never wraps it, so those used to run off the edge
  // for the terminal to break at column 0 — with the background still painting, leaving a colored
  // stub under an aligned block, and a row Ink counted as one while the screen spent two.
  const LONG_LINE =
    'const summary = `Bash failed: ${command} (${reason}) — see the log for details, ' +
    'then retry with a narrower output filter`;';

  it('wraps a long changed line instead of running it past the edge', () => {
    const rows = diffFrame([`  function run() {`, `+ ${LONG_LINE}`, `  }`].join('\n'), 'bash.ts');
    const painted = rows.filter(r => r.includes('summary') || r.includes('narrower'));
    expect(painted.length).toBeGreaterThan(1);
    // Same width on every row: the block stays a rectangle across the wrap.
    expect(new Set(painted.map(r => stringWidth(r))).size).toBe(1);
    for (const row of painted) expect(stringWidth(row)).toBeLessThanOrEqual(width());
    // Nothing is hidden — the tail of the line is on screen, not truncated away.
    expect(painted.join('')).toContain('narrower output filter');
  });

  it('indents the continuation under the code, with the gutter blanked', () => {
    const rows = diffFrame([`  function run() {`, `+ ${LONG_LINE}`, `  }`].join('\n'), 'bash.ts');
    const first = rows.findIndex(r => r.includes('const summary'));
    const codeCol = rows[first].indexOf('const summary');
    const continuation = rows[first + 1];
    // Starts in the code column, and carries no repeated line number.
    expect(continuation.search(/\S/)).toBe(codeCol);
    expect(continuation.slice(0, codeCol).trim()).toBe('');
  });

  it('pads double-width characters by column, not by character count', () => {
    const rows = diffFrame([`- label: "old"`, `+ label: "日本語のラベル"`].join('\n'), 'ui.ts');
    const changed = rows.filter(r => r.includes('label:'));
    expect(changed).toHaveLength(2);
    expect(new Set(changed.map(r => stringWidth(r))).size).toBe(1);
  });
});

// Issue #167: two defects, both visible on a long bash chip.
//
// (1) <Static> is laid out in its own pass that does NOT inherit the App's paddingX={1}, so a
//     plain <Text> row wrapped at the FULL terminal width and was then painted one column in.
//     Every row that filled the line overflowed by exactly one column and the TERMINAL wrapped
//     that one character down to column 0 — the stray `=`, `n` and `|` in the report.
// (2) A marker and its text share one <Text> (they must: adjacent <Text> siblings in a row Box
//     lose the boundary character on wrap), so Ink wrapped the pair at the block's left edge and
//     the continuation row landed flush left instead of under the text it continues.
//
// Both are properties of EVERY marker-prefixed line, so every marker is enumerated here.
describe('Scrollback marker line wrapping', () => {
  const COLS = 60;
  // Long enough to wrap several times at 60 columns, and free of any token that would hard-split.
  const LONG =
    'cd ~/Git/nori && echo "=== css files ===" && find web -iname css && ' +
    'grep -rn now-playing web/src | head && echo "=== how the bar is structured ==="';

  const frame = (messages: Message[]): string[] => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      // Mirror App's own paddingX={1}, which the width math accounts for.
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1} width={COLS}>
          <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />
        </Box>,
      );
      return stripAnsi(lastFrame() ?? '').split('\n');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  // Every marker, the message that renders it, and the column its text hangs from — the App's
  // one column of padding, plus any block margin, plus the marker's own width.
  const MARKERS: Array<{ name: string; msg: Message; indent: number; head: RegExp }> = [
    {
      name: '↳ tool summary',
      msg: { role: 'tool', callId: 't1', summary: `Ran: ${LONG} (2442 bytes output)` },
      indent: 1 + 4, // '  ↳ '
      head: /^\s+↳ Ran: /,
    },
    {
      name: '$ tool command',
      msg: {
        role: 'tool',
        callId: 't1',
        summary: 'Ran: x',
        command: { text: LONG, outputTail: '', outputTruncated: false },
      },
      indent: 1 + 4 + 2, // block marginLeft={4} + '$ '
      head: /^\s+\$ cd /,
    },
    {
      name: '$ shell command',
      msg: { role: 'shell', command: LONG, output: '' },
      indent: 1 + 2, // '$ '
      head: /^\s+\$ cd /,
    },
    {
      name: '• tool call',
      msg: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'bash', args: { command: LONG } }],
      },
      indent: 1 + 2, // '• '
      head: /^\s+• Bash\(/,
    },
    {
      name: '❯ system notice',
      msg: { role: 'system', content: LONG },
      indent: 1 + 2, // '❯ '
      head: /^\s+❯ cd /,
    },
  ];

  for (const { name, msg, indent, head } of MARKERS) {
    it(`hangs every wrapped row of a ${name} line under its text`, () => {
      const lines = frame([msg]);
      const start = lines.findIndex(l => head.test(l));
      expect(start).toBeGreaterThanOrEqual(0);

      // The block's rows run until the first blank line after it (the next block's marginTop).
      const rest: string[] = [];
      for (let i = start + 1; i < lines.length && lines[i]!.trim() !== ''; i++)
        rest.push(lines[i]!);
      expect(rest.length).toBeGreaterThan(0); // it has to actually wrap for this to prove anything

      for (const row of rest) {
        expect(row.slice(0, indent)).toBe(' '.repeat(indent));
        expect(row[indent]).not.toBe(' ');
      }
    });

    it(`keeps every row of a ${name} line inside the terminal`, () => {
      for (const line of frame([msg])) expect(stringWidth(line)).toBeLessThanOrEqual(COLS);
    });
  }

  it('keeps a full scrollback of long lines inside the terminal', () => {
    const lines = frame([
      { role: 'user', content: LONG },
      {
        role: 'assistant',
        content: LONG,
        reasoning: LONG,
        toolCalls: [{ id: 't1', name: 'bash', args: { command: LONG } }],
      },
      {
        role: 'tool',
        callId: 't1',
        summary: `Ran: ${LONG}`,
        command: { text: LONG, outputTail: LONG, outputTruncated: false },
      },
      { role: 'system', content: LONG },
    ]);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLS);
  });
});
