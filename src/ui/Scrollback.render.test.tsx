import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { Scrollback, markProse, noticeLead } from './Scrollback.js';
import { drawnWidth } from './termtext.js';
import { contentWidth } from './layout.js';
import { clearIdentity, setIdentity } from './identity.js';
import { TIMER_AFTER_S } from './format.js';
import { renderMarkdown } from './markdown.js';
import { theme } from './theme.js';
import type { Message } from '../types.js';

// Regression: a tool-call label rendered as two adjacent <Text> siblings in a row
// dropped the boundary character when the line wrapped (long edit args), so
// "⏺︎ Edit(…)" printed as "⏺︎ Edi(…)". The label is now a single <Text> with nested
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

    expect(frame).toContain('⏺︎ Bash(');
    expect(frame).not.toMatch(/⏺︎ Bas\(/);
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

    expect(frame).toContain('⏺︎ Edit(path="packages/ui/src/styles.css")');
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

  it('takes a warn notice lead phrase up to the first dash or colon', () => {
    expect(noticeLead('Still looping — one focused attempt.')).toBe('Still looping');
    expect(noticeLead('Not sandboxed: sandbox-exec is unavailable.')).toBe('Not sandboxed:');
    expect(noticeLead('Fetched https://example.com/a — ok')).toBe('Fetched https://example.com/a');
    expect(noticeLead('No separator in this one.')).toBe('');
    expect(noticeLead(`${'x'.repeat(41)} — too long to be a label`)).toBe('');
    expect(noticeLead('first row wraps\nbefore: the colon')).toBe('');
  });

  it('colors a lead phrase or a whole line by emphasis, and leaves the rest muted', () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      // Ink coalesces adjacent escapes, so match the open code in front of the text.
      const open = (hex: string) => chalk.hex(hex)('x').split('x')[0];
      const warn = frameFor({ role: 'system', tone: 'warn', content: 'Not sandboxed: no binary.' });
      expect(warn).toContain(open(theme.warning) + '⟳ Not sandboxed:');
      expect(warn).toContain(open(theme.muted) + ' no binary.');
      // theme.info is a named color (cyan).
      const info = (emphasis?: 'line' | 'lead') =>
        frameFor({ role: 'system', tone: 'info', emphasis, content: 'Recovering: a round.' });
      expect(info('line')).toContain('\u001b[36m❯ Recovering: a round.');
      expect(info('lead')).toContain('\u001b[36m❯ Recovering:');
      expect(info('lead')).toContain(open(theme.muted) + ' a round.');
      expect(info()).toContain(open(theme.muted) + 'Recovering: a round.');
    } finally {
      chalk.level = prevLevel;
    }
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

  // An error takes prose's row shape, not a box; the label keeps it apart from a reply when color
  // is off, and the body is plain text so a JSON 400 body isn't read as markdown.
  it('renders an error as a marked row with a label, body verbatim', () => {
    const frame = frameFor({ role: 'error', content: '400 {"error":"*bad* `req`"}' });
    expect(frame).toContain('⏺︎ Error: 400 {"error":"*bad* `req`"}');
    expect(frame).not.toContain('╭');
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
  // The command chip's marginLeft, which the committed output sits behind.
  const CHIP = 4;
  // Prose hangs under the `⏺︎ ` marker (#497): drawn 2 columns, budgeted as the 3 Ink measures.
  const PROSE_HANG = 2;
  const PROSE_MARKER_MEASURED = 3;

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

  it('folds a thinking tail the endpoint cut at a tag the model wrote in its own prose', () => {
    // The parser ends the reasoning channel at a literal tag in the model's prose, so the rest of
    // the thought arrives as `content` (ui/reasoningfold.ts). It belongs behind the bar, with no
    // prose row under it.
    const frame = framePlusApp([
      {
        role: 'assistant',
        content: '` the model wrote inside its own reasoning.',
        reasoning: 'the parser cut the think block at a literal `',
        nested: true,
      },
    ]);
    const rows = frame.split('\n').filter(l => l.trim());

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toMatch(new RegExp(`^ {${1 + INDENT}}▎`));
    // The tail wraps across rows, so join the bar-stripped bodies before matching.
    const body = rows.map(r => stripAnsi(r).replace(/^\s*▎\s?/, '')).join(' ');
    expect(body).toContain('the model wrote inside its own reasoning.');
  });

  // #431: markdown wrapped to the top-level width and then landed in a box four columns
  // narrower, so Ink re-wrapped every full line — the last word of a paragraph line, or of a
  // bullet, on a row of its own and flush left, under no hanging indent. The compaction note
  // is where it showed (then a nested assistant reply with prose and a constants list).
  it('wraps a nested reply’s prose and bullets inside the nested box', () => {
    const sentence = 'Tuned constants drift from their documented values, unchecked and unnoticed';
    const content = `Task: ${sentence} (state OPEN).\n\nConstants:\n\n- \`src/agent/loop.ts\`: ${sentence}\n- \`src/agent/compaction.ts\`: ${sentence}`;
    const frame = framePlusApp([{ role: 'assistant', content, nested: true }]);
    const rows = frame.split('\n').filter(l => l.trim());
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    // Ink's own wrap was a no-op: the rows are the markdown's, wrapped to the nested width,
    // each sitting at the nested indent.
    const expected = stripAnsi(
      markProse(renderMarkdown(content, COLS - 2 - INDENT - PROSE_MARKER_MEASURED)),
    )
      .split('\n')
      .filter(l => l.trim())
      .map(l => ' '.repeat(1 + INDENT) + l);
    expect(rows.map(r => r.trimEnd())).toEqual(expected);
    // A bullet's continuation row hangs under its text, not under the marker.
    const bullets = rows.filter(r => r.trimStart().startsWith('•'));
    expect(bullets.length).toBe(2);
    const after = rows[rows.indexOf(bullets[0]) + 1];
    expect(after).toMatch(new RegExp(`^ {${1 + INDENT + PROSE_HANG + 4}}\\S`));
  });

  // #342: a subagent's rounds stream into the parent's (idle) live region. The live blocks must
  // sit at the same indent their committed rows will land at, and wrap inside it — the same
  // width discipline as the committed nested rows above.
  const liveFrame = (props: {
    streaming?: string;
    streamingReasoning?: string;
    streamingTool?: string;
    streamingNested?: boolean;
    streamingCommand?: boolean;
    streamingNote?: boolean;
  }): string => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1} width={COLS}>
          <Scrollback
            messages={[]}
            streaming={props.streaming ?? ''}
            streamingReasoning={props.streamingReasoning ?? ''}
            streamingTool={props.streamingTool ?? ''}
            streamingNested={props.streamingNested}
            streamingCommand={props.streamingCommand}
            streamingNote={props.streamingNote}
          />
        </Box>,
      );
      return lastFrame() ?? '';
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  it('draws a nested live reasoning block at the nested indent, every row behind its bar', () => {
    const frame = liveFrame({
      streamingReasoning:
        'I should look at the config loader before touching any call sites at all.',
      streamingNested: true,
    });
    const rows = frame.split('\n').filter(l => l.trim());
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row).toMatch(new RegExp(`^ {${1 + INDENT}}▎`));
      expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    }
  });

  it('draws nested live content and tool tails at the nested indent, wrapped inside it', () => {
    const long = 'lorem ipsum dolor sit amet consectetur '.repeat(4).trim();
    const frame = liveFrame({
      streaming: long,
      streamingTool: long,
      streamingNested: true,
      streamingCommand: true,
    });
    const rows = frame.split('\n').filter(l => l.trim());
    expect(rows.length).toBeGreaterThan(2);
    // Content's marker row on the nested indent and its continuations hanging under the marker
    // (#497); the command tail one chip margin deeper, where its committed row lands under the
    // `$ command` row (#461). Both wrap inside the nested box.
    const leads = rows.map(row => /^ */.exec(row)![0].length);
    expect(new Set(leads)).toEqual(
      new Set([1 + INDENT, 1 + INDENT + PROSE_HANG, 1 + INDENT + CHIP]),
    );
    for (const row of rows) expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
  });

  // #497: the live tail must draw the marker and hang exactly where the committed message lands,
  // or the prose jumps two columns when it commits (the #461 failure, for prose).
  it('streams prose where it commits, marker and hang included, top level and nested', () => {
    const text = [
      'lorem ipsum dolor sit amet consectetur '.repeat(3).trim(),
      '',
      '- a bullet long enough to wrap onto a second row inside the box',
    ].join('\n');
    const rows = (frame: string): string[] =>
      stripAnsi(frame)
        .split('\n')
        .filter(l => l.trim())
        .map(l => l.trimEnd());
    for (const nested of [false, true]) {
      const live = rows(liveFrame({ streaming: text, streamingNested: nested }));
      const committed = rows(framePlusApp([{ role: 'assistant', content: text, nested }]));
      expect(live).toEqual(committed);
      const lead = 1 + (nested ? INDENT : 0);
      expect(committed[0]).toMatch(new RegExp(`^ {${lead}}⏺︎ lorem`));
      expect(committed[1]).toMatch(new RegExp(`^ {${lead + PROSE_HANG}}\\S`));
      for (const row of committed) expect(stringWidth(row)).toBeLessThanOrEqual(COLS);
    }
  });

  // Prose and tool calls share the glyph and are told apart by brightness (#497).
  it('draws the prose marker in secondary, not the tool-call color', () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const frame = framePlusApp([
        {
          role: 'assistant',
          content: 'Checking the caller next.',
          toolCalls: [{ id: 'c1', name: 'read', args: { path: 'src/a.ts' } }],
        },
      ]);
      const open = (hex: string) => chalk.hex(hex)('⏺︎').split('⏺︎')[0];
      const proseRow = frame.split('\n').find(l => l.includes('Checking'))!;
      const callRow = frame.split('\n').find(l => l.includes('src/a.ts'))!;
      expect(proseRow).toContain(open(theme.secondary) + '⏺︎');
      expect(callRow).toContain(open(theme.tool) + '⏺︎');
    } finally {
      chalk.level = prevLevel;
    }
  });

  // #280: a compaction note's reasoning bar (committed and live) takes the info accent, matching
  // the spinner, so the thinking on screen reads as compaction work rather than the answer.
  it('colors a compaction note’s reasoning bar with the info accent', () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      const committed = (compactionNote: boolean) =>
        framePlusApp([
          {
            role: 'assistant',
            content: 'the note',
            reasoning: 'deriving the note',
            nested: true,
            ...(compactionNote ? { compactionNote: true } : {}),
          },
        ]);
      // Ink coalesces adjacent escapes, so match the open code in front of the bar rather than
      // chalk's exact open+close pair. theme.info is a named color (cyan), theme.reasoning a hex.
      const cyanBar = '\u001b[36m▎ ';
      const reasoningBar = chalk
        .hex(theme.reasoning)('▎ ')
        .replace(/\u001b\[39m$/, '');
      expect(committed(true)).toContain(cyanBar);
      expect(committed(false)).not.toContain(cyanBar);
      expect(committed(false)).toContain(reasoningBar);
    } finally {
      chalk.level = prevLevel;
    }
  });

  // #498: the note is one block behind a single bar at the left edge — Thinking, a bar row, the
  // label, then the note. Nested, it read as a subagent with no chip above it; with the prose
  // marker, as the model's reply.
  const NOTE = 'Findings so far.\n\n- `src/agent/loop.ts` runs the report round before the shed.';
  const noteRows = (frame: string) => frame.split('\n').filter(l => l.trim());

  it('draws a committed compaction note as one barred block at the left edge', () => {
    const rows = noteRows(
      framePlusApp([
        { role: 'assistant', content: NOTE, reasoning: 'deriving it', compactionNote: true },
      ]),
    );
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(row).toMatch(/^ ▎/);
      expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    }
    expect(rows.map(r => r.trimEnd())).toEqual(
      expect.arrayContaining([' ▎ Thinking', ' ▎', ' ▎ Compaction note']),
    );
    const label = rows.findIndex(r => r.includes('Compaction note'));
    expect(rows[label + 1].trimEnd()).toBe(' ▎');
    expect(rows.join('\n')).not.toContain('⏺');
  });

  it('streams a compaction note where it will commit', () => {
    const reasoning = 'deriving it';
    const live = noteRows(
      liveFrame({ streamingReasoning: reasoning, streaming: NOTE, streamingNote: true }),
    );
    const committed = noteRows(
      framePlusApp([{ role: 'assistant', content: NOTE, reasoning, compactionNote: true }]),
    );
    expect(live).toEqual(committed);
  });

  it('leaves the top-level live region byte-identical when not nested', () => {
    const text = 'I should look at the config loader before touching any call sites at all.';
    expect(liveFrame({ streamingReasoning: text, streamingNested: false })).toBe(
      liveFrame({ streamingReasoning: text }),
    );
    expect(liveFrame({ streamingReasoning: text })).toMatch(/^ ▎/m);
  });
});

// #461: a running command's output streams into the live region before its committed chip exists,
// and it has to land where that chip's output will — inside the command margin (the row the `$ …`
// line and its output share, under the `↳ Ran: …` summary), not flush against the tool call above
// it. Shell mode is the exception: its `shell` message draws the `$ command` row and then the output
// at the left edge, so its live tail stays there too.
describe('Scrollback live command tail indent', () => {
  const COLS = 60;
  const CHIP = 4;

  const inApp = (node: React.ReactElement): string => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1} width={COLS}>
          {node}
        </Box>,
      );
      return lastFrame() ?? '';
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  const liveToolFrame = (streamingTool: string, streamingCommand = true): string =>
    inApp(
      <Scrollback
        messages={[]}
        streaming=""
        streamingReasoning=""
        streamingTool={streamingTool}
        streamingCommand={streamingCommand}
      />,
    );

  // The column a row's text starts in — the thing the issue is about.
  const lead = (frame: string, needle: string): number => {
    const row = frame.split('\n').find(l => l.includes(needle));
    expect(row, `no row containing ${needle}`).toBeDefined();
    return /^ */.exec(row!)![0].length;
  };

  it('draws a running command’s tail inside the command margin, where its committed row lands', () => {
    const rows = liveToolFrame('Checking formatting...\nAll matched files are formatted.')
      .split('\n')
      .filter(l => l.trim());
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row).toMatch(new RegExp(`^ {${1 + CHIP}}\\S`));
  });

  it('puts the live tail on the column of the committed output it becomes', () => {
    const output = 'Checking formatting...\nAll matched files are formatted.';
    const committed = inApp(
      <Scrollback
        messages={[
          {
            role: 'tool',
            callId: 't1',
            summary: 'Ran: npm run format:check (55 bytes output)',
            command: { text: 'npm run format:check', outputTail: output, outputTruncated: false },
          },
        ]}
        streaming=""
        streamingReasoning=""
        streamingTool=""
      />,
    );
    expect(lead(committed, 'Checking formatting')).toBe(
      lead(liveToolFrame(output), 'Checking formatting'),
    );
  });

  it('wraps a long tail inside the margin instead of running past the terminal', () => {
    const long = Array.from(
      { length: 6 },
      (_, i) => `row ${i}: ${'lorem ipsum dolor '.repeat(6)}`,
    ).join('\n');
    const rows = liveToolFrame(long)
      .split('\n')
      .filter(l => l.trim());
    expect(rows.length).toBeGreaterThan(6);
    for (const row of rows) {
      // Every row of the block, wrapped ones included: the break no longer leaves its space at the
      // head of the continuation row, which used to stagger those rows one column right.
      expect(row).toMatch(new RegExp(`^ {${1 + CHIP}}\\S`));
      expect(row.trimEnd().length).toBeLessThanOrEqual(COLS);
    }
  });

  it('leaves shell mode’s live tail at the left edge, where its shell message prints it', () => {
    const rows = liveToolFrame('total 8\ndrwxr-xr-x 1 octocat staff', false)
      .split('\n')
      .filter(l => l.trim());
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row).toMatch(/^ \S/);
  });

  it('leaves a non-command tool’s live line at the left edge, where its notice commits', () => {
    const rows = liveToolFrame(
      'The search engine served a bot check. Complete it in the browser window.',
      false,
    )
      .split('\n')
      .filter(l => l.trim());
    for (const row of rows) expect(row).toMatch(/^ \S/);
  });
});

// The live in-flight row (#509): a model tool call that is dispatched but has not returned yet —
// the gap where a stalled `bash` or a never-streaming `edit` left the committed call row above it
// looking like the app had stopped.
describe('Scrollback pending tool row', () => {
  const COLS = 60;

  const inApp = (node: React.ReactElement): string => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      const { lastFrame } = render(
        <Box flexDirection="column" paddingX={1} width={COLS}>
          {node}
        </Box>,
      );
      return lastFrame() ?? '';
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  const liveFrame = (pendingTool: string, streamingTool = '', pendingToolMs = 0): string =>
    inApp(
      <Scrollback
        messages={[]}
        streaming=""
        streamingReasoning=""
        streamingTool={streamingTool}
        streamingCommand
        pendingTool={pendingTool}
        pendingToolMs={pendingToolMs}
      />,
    );

  const lead = (frame: string, needle: string): number => {
    const row = frame.split('\n').find(l => l.includes(needle));
    expect(row, `no row containing ${needle}`).toBeDefined();
    return /^ */.exec(row!)![0].length;
  };

  it('draws the arrow and the call’s verb while the call is in flight', () => {
    expect(liveFrame('bash')).toContain('↳ Running…');
    expect(liveFrame('edit')).toContain('↳ Editing…');
    expect(liveFrame('read')).toContain('↳ Reading…');
    // File search says Matching, not Searching: that one belongs to the web tool, which is a
    // different gesture committing under a different noun.
    expect(liveFrame('grep')).toContain('↳ Matching…');
    expect(liveFrame('search')).toContain('↳ Searching…');
  });

  // The row is the result row's own slot with the result not in it yet: same marker, same column,
  // so the swap when the tool returns is a text-only change and nothing jumps.
  it('sits where the committed result row lands', () => {
    const committed = inApp(
      <Scrollback
        messages={[
          {
            role: 'tool',
            callId: 't1',
            summary: 'Ran: npm run format:check',
            command: { text: 'npm run format:check', outputTail: 'ok', outputTruncated: false },
          },
        ]}
        streaming=""
        streamingReasoning=""
        streamingTool=""
      />,
    );
    expect(lead(liveFrame('bash'), '↳ Running…')).toBe(lead(committed, '↳ Ran:'));
  });

  // Above the tail, not below it: the `$ command` chip's output commits under the `↳ Ran:` row.
  it('sits above a running command’s live tail', () => {
    const frame = liveFrame('bash', 'Checking formatting...');
    const rows = frame.split('\n');
    expect(rows.findIndex(l => l.includes('↳ Running…'))).toBeLessThan(
      rows.findIndex(l => l.includes('Checking formatting')),
    );
  });

  // The second call of a round: its result gets a gap when either row carries a block (#492), so
  // the in-flight row has to take it too or the gap only appears at the swap.
  it('takes the gap its committed result will get', () => {
    const chip: Message = {
      role: 'tool',
      callId: 't1',
      summary: 'Ran: npm test',
      command: { text: 'npm test', outputTail: 'ok', outputTruncated: false },
    };
    const readRow: Message = { role: 'tool', callId: 't1', summary: 'Read src/a.ts' };
    const rowsAbove = (messages: Message[], pendingTool: string): string[] => {
      const rows = inApp(
        <Scrollback
          messages={messages}
          streaming=""
          streamingReasoning=""
          streamingTool=""
          pendingTool={pendingTool}
        />,
      ).split('\n');
      const at = rows.findIndex(l => l.includes('↳ ') && l.includes('…'));
      return rows.slice(at - 1, at);
    };
    expect(rowsAbove([chip], 'read')[0].trim()).toBe('');
    expect(rowsAbove([readRow], 'bash')[0].trim()).toBe('');
    expect(rowsAbove([readRow], 'read')[0]).toContain('↳ src/a.ts');
  });

  it('draws nothing when no call is running', () => {
    expect(liveFrame('')).not.toContain('↳ ');
  });

  // #585: the row is the user's only sign of life while a command prints nothing, and a `bash` is
  // the one call that can legitimately take minutes (#408) — so it carries the call's age. Same row
  // as the verb, not a second one: the live frame's row budget is unchanged by the timer.
  it('ages a bash row that has been running a while', () => {
    const frame = liveFrame('bash', '', 303_000);
    expect(frame).toContain('↳ Running… · 5m 03s');
    expect(frame.split('\n').findIndex(l => l.includes('↳ Running…'))).toBe(
      frame.split('\n').findIndex(l => l.includes('5m 03s')),
    );
  });

  // Under the threshold the row is byte-identical to #509's, which is what keeps a quick command
  // from flashing a counter it never gets past 1.
  it('leaves the row as it was until the call has been running a while', () => {
    expect(liveFrame('bash', '', TIMER_AFTER_S * 1000 - 1)).toContain('↳ Running…');
    expect(liveFrame('bash', '', TIMER_AFTER_S * 1000 - 1)).not.toContain('· ');
  });

  // The other tools finish in seconds, so a timer on them would be noise — and the number would sit
  // on a row whose own claim (`Reading…`) is what the user is reading.
  it('times bash only', () => {
    expect(liveFrame('read', '', 60_000)).toContain('↳ Reading…');
    expect(liveFrame('read', '', 60_000)).not.toContain('· ');
  });

  // The committed half of the same chip (#585): the `↳ Ran:` row carries the call's total, so the
  // swap at commit is a text-only change of verb. The duration rides the message (`loop.ts` stamps
  // it around `tool.run`) and NOT the summary — see types.ts Message['tool'].durationMs.
  it('carries the call’s total on the row it commits as', () => {
    const run: Message = {
      role: 'tool',
      callId: 't1',
      summary: 'Ran: npm ci (12 bytes output)',
      command: { text: 'npm ci', outputTail: 'ok', outputTruncated: false },
      durationMs: 303_000,
    };
    expect(frameFor(run)).toContain('↳ Ran: npm ci (12 bytes output) · 5m 03s');
    // Same row as the summary, not a second one.
    const rows = frameFor(run).split('\n');
    expect(rows.findIndex(l => l.includes('↳ Ran:'))).toBe(
      rows.findIndex(l => l.includes('5m 03s')),
    );
  });

  // Everything the rule excludes leaves the row exactly as it was before the chip existed: a quick
  // command, a non-bash tool, and a call that never ran (no duration at all).
  it('leaves the committed row alone otherwise', () => {
    const base = {
      role: 'tool',
      callId: 't1',
      summary: 'Ran: npm ci (12 bytes output)',
      command: { text: 'npm ci', outputTail: 'ok', outputTruncated: false },
    } satisfies Message;
    expect(frameFor({ ...base, durationMs: 1_000 })).toContain('↳ Ran: npm ci (12 bytes output)');
    expect(frameFor({ ...base, durationMs: 1_000 })).not.toContain('· ');
    expect(
      frameFor({ role: 'tool', callId: 't1', summary: 'Read src/a.ts', durationMs: 60_000 }),
    ).not.toContain('· ');
    expect(frameFor({ ...base, durationMs: undefined })).not.toContain('· ');
  });

  // The chip lands at the end of the summary's last wrapped row, and the wrap pays for it: a summary
  // whose last row is full pushes the chip onto a row of its own, which reads as a stray
  // ` · 5m 03s` sitting under the row. Measured — the text below renders exactly that without the
  // reserved width.
  it('keeps the chip on the summary’s last row when that row wraps', () => {
    const summary = `Ran: ${'word '.repeat(20)}end`;
    const rows = inApp(
      <Scrollback
        messages={[
          {
            role: 'tool',
            callId: 't1',
            summary,
            command: { text: 'npm ci', outputTail: '', outputTruncated: false },
            durationMs: 303_000,
          },
        ]}
        streaming=""
        streamingReasoning=""
        streamingTool=""
      />,
    )
      .split('\n')
      .filter(l => l.trim());
    expect(rows.length).toBeGreaterThan(2); // it really wrapped
    const chipRow = rows.findIndex(l => l.includes('5m 03s'));
    expect(chipRow).toBeGreaterThan(0);
    expect(rows[chipRow]).toContain('end');
    expect(rows[chipRow]).toMatch(/end · 5m 03s/);
  });

  // The row is a live-region row like any other, so it has to come out of the same viewport budget
  // the streamed blocks do — otherwise a long tail plus the row tops stdout.rows and Ink repaints
  // the whole terminal (clearing native scrollback) every frame. The frame is therefore exactly as
  // tall with the row as without it: the tail gives up the row the call row takes.
  it('comes out of the live frame’s budget instead of adding to it', () => {
    const prev = { rows: process.stdout.rows, columns: process.stdout.columns };
    Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
    try {
      const big = Array.from({ length: 500 }, (_, i) => `tool ${i}: ${'word '.repeat(12)}`).join(
        '\n',
      );
      const frame = (pendingTool: string): string[] =>
        (
          render(
            <Scrollback
              messages={[]}
              streaming=""
              streamingReasoning=""
              streamingTool={big}
              pendingTool={pendingTool}
            />,
          ).lastFrame() ?? ''
        ).split('\n');
      const withRow = frame('bash');
      const without = frame('');
      expect(withRow[0]).toContain('↳ Running…');
      expect(withRow.length).toBe(without.length);
      expect(withRow.length).toBeLessThan(process.stdout.rows);
    } finally {
      Object.defineProperties(process.stdout, {
        rows: { value: prev.rows, configurable: true },
        columns: { value: prev.columns, configurable: true },
      });
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

// Files a bash command changed render under its chip the way an edit's diff does (#278): a path
// line with the stat tag, then the hunks with a line-number gutter, then what was left out.
describe('Scrollback bash tree changes', () => {
  const frameFor = (changes: NonNullable<Extract<Message, { role: 'tool' }>['changes']>) => {
    const messages: Message[] = [
      {
        role: 'tool',
        callId: 't1',
        summary: 'Ran: make fix (0 bytes output)',
        command: { text: 'make fix', outputTail: '', outputTruncated: false },
        changes,
      },
    ];
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return stripAnsi(lastFrame() ?? '');
  };

  it('draws each changed file with its stat tag and its hunks', () => {
    const frame = frameFor({
      files: [
        {
          path: 'src/a.ts',
          kind: 'modified',
          hunks: [
            { text: '  keep\n- old\n+ new', startLine: 1, oldStartLine: 1 },
            { text: '  far\n+ later', startLine: 40, oldStartLine: 39 },
          ],
          added: 2,
          removed: 1,
        },
        { path: 'img.png', kind: 'binary', hunks: [], added: 0, removed: 0 },
      ],
      more: 0,
    });
    expect(frame).toContain('src/a.ts (+2 -1)');
    expect(frame).toMatch(/2 - old/);
    expect(frame).toMatch(/2 \+ new/);
    expect(frame).toMatch(/41 \+ later/);
    expect(frame).toContain('img.png (binary)');
    expect(frame).not.toContain('more files changed');
  });

  it('says what it left out rather than ending quietly', () => {
    const frame = frameFor({
      files: [
        {
          path: 'gen.ts',
          kind: 'created',
          hunks: [{ text: '+ a', startLine: 1, oldStartLine: 1 }],
          added: 90,
          removed: 0,
          omitted: 89,
        },
      ],
      more: 3,
    });
    expect(frame).toContain('gen.ts (new, +90)');
    expect(frame).toContain('…(89 more lines)');
    expect(frame).toContain('…3 more files changed');
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

  const diffFrame = (diff: string, path = 'main.go', nested = false, raw = false): string[] => {
    const messages: Message[] = [
      {
        role: 'tool',
        callId: 't1',
        summary: `Edited ${path}`,
        nested,
        diff: { text: diff, path, added: 1, removed: 1, startLine: 10 },
      },
    ];
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    // Stripped for the assertions below: with color forced on, the highlighter's escapes sit
    // between tokens, so column math and substring matching have to run on the visible text.
    // string-width ignores escapes either way, so the width assertions are unaffected. `raw` keeps
    // them, for the one case that has to tell a tinted row from a context one.
    return (lastFrame() ?? '').split('\n').map(raw ? (l: string) => l : stripAnsi);
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

  // A changed line holding a glyph the terminal draws in ONE cell while string-width spends TWO on
  // (`✔`, `⚠`, `⏺` — `drawnWidth`, termtext.ts) is padded by the drawn width, which makes the row
  // MEASURE wider than it draws. Ink re-wraps whatever runs past the width it was handed, so that
  // slack landed on a row of its own under the block (#439): the row box is given it as budget
  // instead. Both halves are pinned here, since this is the path with a width-bounded block around
  // the diff — a bare DiffView render lays the row out too loosely to reproduce the tear.
  it('keeps a row holding a one-cell pictograph padded and untorn', () => {
    const rows = diffFrame(
      [`  const x = 1;`, `- label: "old"`, `+ done ✔ ok`, `  }`].join('\n'),
      'ui.ts',
    );
    const plain = rows.find(r => r.includes('label: "old"'))!;
    const glyph = rows.find(r => r.includes('done ✔ ok'))!;
    // One block, so the same drawn width — a `✔` used to leave this row a column short.
    expect(drawnWidth(glyph)).toBe(drawnWidth(plain));
    // And nothing spilled below it: a wrapped pad shows up as a line holding only whitespace.
    expect(rows.filter(r => r !== '' && r.trim() === '')).toEqual([]);
  });

  // contentWidth floors at 20 columns. Past the floor `contentWidth(DIFF_MARGIN + indent)` and the
  // box the diff sits in stop agreeing, so the block was laid out wider than its own container and
  // Ink re-wrapped every full row: the space between the gutter and the code came off the boundary
  // (`11+ const`) and the rows ran to whatever length the wrap left them. Clamped, the block is a
  // rectangle again. 28 columns is the width where the top-level case still has room and the nested
  // one does not, so it is the nested block that pins this.
  it('keeps a nested diff inside its box below the 20-column floor', () => {
    const COLS = 28;
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      // A line long enough to wrap: a short one only shows the overflow as `pad` columns Ink
      // clips off the end, which no assertion can see. The raw frame is what tells a tinted row
      // from a context one (the row background), so the block can be measured as a block.
      const rows = diffFrame(
        [`  function run() {`, `+ ${LONG_LINE}`, `  }`].join('\n'),
        'bash.ts',
        true,
        true,
      );
      const tinted = rows.filter(r => r.includes('\x1b[48;2;')).map(r => drawnWidth(stripAnsi(r)));
      expect(tinted.length).toBeGreaterThan(1); // it has to wrap for this to prove anything
      // One block: every row of the wrapped line draws to the same column — and that column is
      // where the box the diff sits in ends (the subagent indent, the diff's own marginLeft={4},
      // and the width that leaves), not two columns past it as the unclamped floor had it.
      const content = contentWidth(4) - 4;
      expect(new Set(tinted)).toEqual(new Set([4 + 4 + content]));
      // And the pad did not tear off onto a row of its own under it.
      expect(rows.filter(r => stripAnsi(r) !== '' && stripAnsi(r).trim() === '')).toEqual([]);
      for (const row of rows) expect(drawnWidth(stripAnsi(row))).toBeLessThanOrEqual(COLS);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
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
    'cd ~/Git/demo && echo "=== css files ===" && find web -iname css && ' +
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
      name: '⏺︎ tool call',
      msg: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'bash', args: { command: LONG } }],
      },
      indent: 1 + 2, // '⏺︎ '
      head: /^\s+⏺︎ Bash\(/,
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

// #172: the user bubble was the last render site running neither scrubber. It goes unnoticed for
// a typed prompt (the user knows their own paths) but not for a subagent's task text, which the
// parent model writes with absolute paths — so the nested bubble printed the home directory in
// full directly under a `Subagent(task=…)` line that had already collapsed it via formatArgs.
describe('Scrollback user-bubble scrubbing', () => {
  const WIDE = 140;
  const wideFrame = (msg: Message): string => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: WIDE, configurable: true });
    try {
      return frameFor(msg);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  it('collapses $HOME in a nested (subagent) task to ~', () => {
    const frame = wideFrame({
      role: 'user',
      content: `Read ${homedir()}/work/web/src/scripts/trackmenu.ts and quote deleteTrack.`,
      nested: true,
    });
    expect(frame).toContain('~/work/web/src/scripts/trackmenu.ts');
    expect(frame).not.toContain(homedir());
  });

  it('scrubs a top-level user message the same way', () => {
    const frame = wideFrame({ role: 'user', content: `open ${homedir()}/notes.md` });
    expect(frame).toContain('~/notes.md');
    expect(frame).not.toContain(homedir());
  });

  it('redacts a signing identity pasted into a prompt', () => {
    const frame = wideFrame({
      role: 'user',
      content: 'why does "Developer ID Application: Jane Dev (AB12CD34EF)" fail?',
    });
    expect(frame).toContain('<redacted>');
    expect(frame).not.toContain('Jane Dev');
  });

  // The bubble pads every row to a fixed width against a grey background, so an unsanitized tab
  // measures short and fractures the block — the same class of break as #154.
  it('expands a tab rather than padding the row against a mis-measured width', () => {
    const frame = wideFrame({ role: 'user', content: 'a\tb' });
    expect(frame).not.toContain('\t');
    expect(frame).toContain('a       b'); // expanded to the 8-column tab stop
  });
});

// #172: the accent bar reads as "the user said this". Inside a subagent the bubble carries the
// parent model's task text, so it must not wear the user's color.
describe('Scrollback nested user-bubble color', () => {
  // Color is forced on: at chalk level 0 the bar's escapes disappear and there is nothing to assert.
  let level: typeof chalk.level;
  beforeAll(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = level;
  });

  // The escape run chalk emits ahead of the bar glyph for a given hex — what Ink writes too.
  const open = (hex: string) => chalk.hex(hex)('\u258e').split('\u258e')[0];
  const barRun = (msg: Message): string =>
    (
      frameFor(msg)
        .split('\n')
        .find(l => l.includes('\u258e')) ?? ''
    ).split('\u258e')[0];

  it('gives a nested bubble the subagent color, not the user accent', () => {
    const run = barRun({ role: 'user', content: 'find every call site', nested: true });
    expect(run).toContain(open(theme.subagent));
    expect(run).not.toContain(open(theme.accent));
  });

  it('keeps the accent bar on a real user message', () => {
    const run = barRun({ role: 'user', content: 'find every call site' });
    expect(run).toContain(open(theme.accent));
    expect(run).not.toContain(open(theme.subagent));
  });

  // `▎` is a legend, not decoration: three different speakers share the glyph and are told apart
  // by color alone. theme.ts says so in prose next to `subagent` — so it is pinned here rather
  // than left as a comment a later palette tweak could quietly falsify.
  it('keeps every ▎ speaker on a distinct color', () => {
    const bars = { reasoning: theme.reasoning, user: theme.accent, subagent: theme.subagent };
    expect(new Set(Object.values(bars)).size).toBe(Object.keys(bars).length);
  });

  // The specific collision that decided the color: `queued` marks the user's own words waiting to
  // be sent, and a queued message sits in the chrome while a subagent runs — so an orange bar
  // would clash on the one axis this bubble exists to disambiguate (who is speaking).
  it('does not reuse the queued orange for the subagent bar', () => {
    expect(theme.subagent).not.toBe(theme.queued);
  });
});

// #172: a tool row has no marginTop of its own (it sits tight under the call that produced it),
// so the parent's "↳ Subagent completed (…)" landed on the line directly below the subagent's
// closing "■ Worked for 10s" with nothing separating the two blocks.
describe('Scrollback subagent block spacing', () => {
  const workedFor: Message = {
    role: 'assistant',
    content: 'done',
    durationMs: 10_000,
    nested: true,
  };
  const completed: Message = {
    role: 'tool',
    callId: 't1',
    summary: 'Subagent completed (525 chars)',
  };

  const linesOf = (messages: Message[]): string[] => {
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return stripAnsi(lastFrame() ?? '').split('\n');
  };

  it('separates the subagent’s last line from the parent tool result', () => {
    const lines = linesOf([workedFor, completed]);
    const worked = lines.findIndex(l => l.includes('Worked for'));
    const done = lines.findIndex(l => l.includes('Subagent completed'));
    expect(worked).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(worked + 1);
    expect(lines.slice(worked + 1, done).every(l => !l.trim())).toBe(true);
  });

  it('keeps a tool row tight under its own tool call', () => {
    const lines = linesOf([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', callId: 't1', summary: 'Read a.ts lines 1–10 of 10' },
    ]);
    const call = lines.findIndex(l => l.includes('⏺︎ Read('));
    const result = lines.findIndex(l => l.includes('↳'));
    expect(result).toBe(call + 1);
  });
});

// #627. #567 dropped the leading "Read " from a result row on the argument that the call directly
// above it already says which tool this is — an argument that holds only while that call is alone.
// Stacked, every row was `  ↳ <path> …` and the marker named none of them, so which of the rows
// were reads had to be re-derived from the paths themselves.
describe('Scrollback stacked read labels', () => {
  const readCall = (id: string, path: string) => ({
    id,
    name: 'read',
    args: { path },
  });
  const readResult = (id: string, summary: string): Message => ({
    role: 'tool',
    callId: id,
    summary,
  });
  const linesOf = (messages: Message[]): string[] => {
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return stripAnsi(lastFrame() ?? '').split('\n');
  };
  const resultRows = (messages: Message[]): string[] =>
    linesOf(messages)
      .filter(l => l.includes('↳'))
      .map(l => l.trim());

  it('puts the verb back on every row of a stacked round', () => {
    const rows = resultRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          readCall('t1', 'src/a.ts'),
          readCall('t2', 'src/b.ts'),
          readCall('t3', 'src/c.ts'),
        ],
      },
      readResult('t1', 'Read src/a.ts lines 1-80 of 402'),
      readResult('t2', 'Read src/b.ts lines 1-30 of 96'),
      readResult('t3', 'Read src/c.ts lines 5-12 of 20'),
    ]);
    expect(rows.map(l => l.replace(/^↳ /, ''))).toEqual([
      'Read src/a.ts lines 1-80 of 402',
      'Read src/b.ts lines 1-30 of 96',
      'Read src/c.ts lines 5-12 of 20',
    ]);
  });

  // The issue's own carve-out: a single read is where the verb was redundant, and its row must not
  // move. Byte-identical to what #567 left, which is also what the reverse-direction arm compares.
  it('leaves a lone read exactly as it was', () => {
    const rows = resultRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [readCall('t1', 'src/a.ts')],
      },
      readResult('t1', 'Read src/a.ts lines 1-80 of 402'),
    ]);
    expect(rows).toEqual(['↳ src/a.ts lines 1-80 of 402']);
    expect(linesOf([readResult('t1', 'Read src/a.ts lines 1-80 of 402')])).not.toContain('Read:');
  });

  // Two results from different rounds — a delivered result followed by a later turn's — land as
  // adjacent rows with no call of their own in between. The second scans the row above and is
  // labelled; the first is frozen before the second exists, so it keeps the bare path. Both the
  // live frame and a replayed one read the same way, which is the bar (#631).
  it('labels a read under a read row above it, round or no round', () => {
    const rows = resultRows([
      readResult('t1', 'Read src/a.ts lines 1-80 of 402'),
      readResult('t2', 'Read src/b.ts lines 1-30 of 96'),
    ]);
    expect(rows).toEqual(['↳ src/a.ts lines 1-80 of 402', '↳ Read src/b.ts lines 1-30 of 96']);
  });

  // The regression the one-shot renders above cannot see (#631): `<Static>` freezes each row as
  // it lands and a round's results commit one at a time, so the FIRST row of a stack must carry
  // its verb from what is knowable at that moment — the round's call list — or it stays bare on
  // screen forever while its siblings are labelled. Commit the results one render apart.
  it('labels the first row of a stack before its sibling results land', () => {
    const round: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [readCall('t1', 'src/a.ts'), readCall('t2', 'src/b.ts')],
    };
    const r1 = readResult('t1', 'Read src/a.ts lines 1-80 of 402');
    const r2 = readResult('t2', 'Read src/b.ts lines 1-30 of 96');
    const sb = (messages: Message[]) => (
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />
    );
    const { rerender, frames } = render(sb([round, r1]));
    const first = stripAnsi(frames.at(-1) ?? '');
    expect(first).toContain('↳ Read src/a.ts lines 1-80 of 402');
    rerender(sb([round, r1, r2]));
    const last = stripAnsi(frames.at(-1) ?? '');
    expect(last).toContain('↳ Read src/a.ts lines 1-80 of 402');
    expect(last).toContain('↳ Read src/b.ts lines 1-30 of 96');
  });

  // A result whose neighbour carries a block is separated from it by a blank row (#492), so it is
  // never scanned as part of that block and keeps the bare path. Row-adjacency arm only — the
  // round arm below is gap-proof on purpose.
  it('does not group a read across the gap a block puts under its neighbour', () => {
    const rows = resultRows([
      readResult('t1', 'Read a.ts lines 1-10 of 10'),
      {
        role: 'tool',
        callId: 't2',
        summary: 'Ran: npm test',
        command: { text: 'npm test', outputTail: 'ok', outputTruncated: false },
      },
    ]);
    expect(rows[0]).toBe('↳ a.ts lines 1-10 of 10');
    expect(rows[1]).toContain('Ran: npm test');
  });

  // A round's results print in call order, so [read, bash, read] separates the two read rows with
  // the command's block between them. The label is round-scoped ("this round read more than one
  // file"), so no interleaving of other calls strips it from either read row (#631).
  it('labels every read of a multi-read round even when other results interleave', () => {
    const rows = resultRows([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          readCall('t1', 'src/a.ts'),
          { id: 't2', name: 'bash', args: { command: 'npm test' } },
          readCall('t3', 'src/b.ts'),
        ],
      },
      readResult('t1', 'Read src/a.ts lines 1-80 of 402'),
      {
        role: 'tool',
        callId: 't2',
        summary: 'Ran: npm test',
        command: { text: 'npm test', outputTail: 'ok', outputTruncated: false },
      },
      readResult('t3', 'Read src/b.ts lines 1-30 of 96'),
    ]);
    expect(rows[0]).toBe('↳ Read src/a.ts lines 1-80 of 402');
    expect(rows[1]).toContain('Ran: npm test');
    expect(rows[2]).toBe('↳ Read src/b.ts lines 1-30 of 96');
  });

  // The elision is not "any Read row" — the two shapes whose verb is their only label keep it even
  // when lone (`Read failed: …`, `Read a.ts: offset …`), since stripping those gives `failed: …`.
  it('keeps the verb on the shapes where it is the only label', () => {
    const merged = linesOf([
      readResult('t1', 'Read a.ts: offset 99 past end of file (10 lines)'),
      readResult('t2', 'Read failed: no such file'),
    ]);
    expect(merged.join('\n')).toContain('↳ Read a.ts: offset 99 past end of file');
    expect(merged.join('\n')).toContain('↳ Read failed: no such file');
    expect(merged.join('\n')).not.toContain('↳ a.ts: offset');
    expect(merged.join('\n')).not.toContain('↳ failed:');
  });

  // Sole purpose is to prove the branch is read-only for every other tool: `Ran:`/`Found` already
  // name themselves, so a stacked grep must not be reformatted into `Found:`.
  it('does not touch the verb of any other tool', () => {
    const rows = resultRows([
      readResult('t1', 'Found 3 matches for /kana/ — showing 3'),
      readResult('t2', 'Listed 12 entries in src'),
      readResult('t3', 'Ran: npm ci'),
    ]);
    expect(rows).toEqual([
      '↳ Found 3 matches for /kana/ — showing 3',
      '↳ Listed 12 entries in src',
      '↳ Ran: npm ci',
    ]);
  });

  // A subagent's reads stack at the nested indent, and every message in the block is nested — the
  // sibling check once rejected any nested neighbour, so these rows could never group and kept the
  // bare form the issue complains about. Same level groups now.
  it('labels stacked reads inside a subagent block', () => {
    const rows = resultRows([
      {
        role: 'assistant',
        content: '',
        nested: true,
        toolCalls: [readCall('n1', 'src/a.ts'), readCall('n2', 'src/b.ts')],
      },
      { ...readResult('n1', 'Read src/a.ts lines 1-80 of 402'), nested: true },
      { ...readResult('n2', 'Read src/b.ts lines 1-30 of 96'), nested: true },
    ]);
    expect(rows.map(l => l.replace(/^↳ /, ''))).toEqual([
      'Read src/a.ts lines 1-80 of 402',
      'Read src/b.ts lines 1-30 of 96',
    ]);
  });

  // The boundary is where the indent changes: a top-level row must not scan into a subagent block
  // or vice versa, and each side alone keeps the bare path the lone-call rule wants.
  it('does not group across the subagent boundary', () => {
    const rows = resultRows([
      {
        role: 'assistant',
        content: '',
        nested: true,
        toolCalls: [readCall('n1', 'src/a.ts')],
      },
      { ...readResult('n1', 'Read src/a.ts lines 1-80 of 402'), nested: true },
      {
        role: 'assistant',
        content: '',
        toolCalls: [readCall('t1', 'src/b.ts')],
      },
      readResult('t1', 'Read src/b.ts lines 1-30 of 96'),
    ]);
    expect(rows).toEqual(['↳ src/a.ts lines 1-80 of 402', '↳ src/b.ts lines 1-30 of 96']);
  });
});

// Regression (#385): <Static> prints `items.slice(n)` where n is the length it saw last render,
// so a mode switch that swaps `messages` for the other side's stash — or /new replacing it with a
// two-line receipt — printed nothing when the new array was no longer than the old one, and
// reprinted already-shown stash rows when it was longer. The scrollback log is append-only by
// message identity: each object prints once, when it first appears.
describe('Scrollback append-only log', () => {
  const sb = (messages: Message[]) => (
    <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />
  );
  const rows = (frames: string[]): string[] =>
    frames
      .map(stripAnsi)
      .join('\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  const count = (frames: string[], text: string): number =>
    rows(frames).filter(l => l.endsWith(text)).length;

  it('prints the banner after a round trip through /chat from a fresh session', () => {
    const chatEcho: Message = { role: 'user', content: '/chat', meta: true };
    const chatBanner: Message = { role: 'system', content: 'Chat mode.' };
    const agentEcho: Message = { role: 'user', content: '/agent', meta: true };
    const agentBanner: Message = { role: 'system', content: 'Agent mode.' };
    const { rerender, frames } = render(sb([]));
    // → chat: the agent stash is empty, so the array is just the trailing pair.
    rerender(sb([chatEcho, chatBanner]));
    // → agent: the empty agent stash comes back plus a new trailing pair — same length as before.
    rerender(sb([agentEcho, agentBanner]));
    const last = rows([frames.at(-1) ?? '']);
    expect(last).toEqual(['▎ /chat', '❯ Chat mode.', '▎ /agent', '❯ Agent mode.']);
  });

  it('does not reprint a restored stash that is already on screen', () => {
    const a1: Message = { role: 'system', content: 'agent one' };
    const a2: Message = { role: 'system', content: 'agent two' };
    const a3: Message = { role: 'system', content: 'agent three' };
    const chatBanner: Message = { role: 'system', content: 'Chat mode.' };
    const agentBanner: Message = { role: 'system', content: 'Agent mode.' };
    const { rerender, frames } = render(sb([a1, a2, a3]));
    rerender(sb([chatBanner]));
    // Restoring three rows after a one-row chat side used to reprint a2 and a3.
    rerender(sb([a1, a2, a3, agentBanner]));
    const last = rows([frames.at(-1) ?? '']);
    expect(last).toEqual([
      '❯ agent one',
      '❯ agent two',
      '❯ agent three',
      '❯ Chat mode.',
      '❯ Agent mode.',
    ]);
    expect(count([frames.at(-1) ?? ''], 'agent two')).toBe(1);
  });

  it('prints the /new receipt after a conversation longer than the receipt', () => {
    const history: Message[] = [
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'system', content: 'three' },
    ];
    const echo: Message = { role: 'user', content: '/new', meta: true };
    const notice: Message = { role: 'system', content: 'New session.' };
    const { rerender, frames } = render(sb(history));
    rerender(sb([echo, notice]));
    const last = rows([frames.at(-1) ?? '']);
    expect(last.slice(-2)).toEqual(['▎ /new', '❯ New session.']);
  });

  it('is a no-op for an ordinary append', () => {
    const a: Message = { role: 'system', content: 'first' };
    const b: Message = { role: 'system', content: 'second' };
    const { rerender, frames } = render(sb([a]));
    rerender(sb([a, b]));
    const last = rows([frames.at(-1) ?? '']);
    expect(last).toEqual(['❯ first', '❯ second']);
  });
});

// A top-level turn's "Worked for" line committed with its message while the spinner was still up,
// so the spinner leaving shrank the frame and moved the input up at the end of every turn. It is
// held and drawn live in the spinner's rows until the next user message commits it.
describe('Scrollback held "Worked for" line', () => {
  const answer: Message = { role: 'assistant', content: 'The answer.', durationMs: 5_000 };
  const notice: Message = { role: 'system', content: 'Typecheck passed.' };
  const next: Message = { role: 'user', content: 'thanks' };
  const sb = (messages: Message[], showHeldWorked: boolean) => (
    <Scrollback
      messages={messages}
      streaming=""
      streamingReasoning=""
      streamingTool=""
      showHeldWorked={showHeldWorked}
    />
  );
  const rows = (frame: string | undefined): string[] =>
    stripAnsi(frame ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

  it('stays out of the frame while the spinner holds its rows', () => {
    const { lastFrame } = render(sb([answer], false));
    expect(rows(lastFrame())).toEqual(['⏺︎ The answer.']);
  });

  it('draws below end-of-turn notices once idle', () => {
    const { lastFrame } = render(sb([answer, notice], true));
    expect(rows(lastFrame())).toEqual(['⏺︎ The answer.', '❯ Typecheck passed.', '■ Worked for 5s']);
  });

  it('commits once, above the next user message', () => {
    const { rerender, lastFrame } = render(sb([answer, notice], true));
    rerender(sb([answer, notice, next], false));
    expect(rows(lastFrame())).toEqual([
      '⏺︎ The answer.',
      '❯ Typecheck passed.',
      '■ Worked for 5s',
      '▎ thanks',
    ]);
  });

  it('commits the previous line when another turn ends without a user message between', () => {
    const second: Message = { role: 'assistant', content: 'Second.', durationMs: 2_000 };
    const { rerender, lastFrame } = render(sb([answer], true));
    rerender(sb([answer, second], true));
    expect(rows(lastFrame())).toEqual([
      '⏺︎ The answer.',
      '■ Worked for 5s',
      '⏺︎ Second.',
      '■ Worked for 2s',
    ]);
  });
});

// The mid-turn sandbox notice (once per cwd, committed alongside the first bash result) sits
// between two tool rows. Tool rows carry no marginTop of their own — spacing normally belongs to
// the assistant call above them — so the notice used to run straight into the next tool row (#485).
describe('Scrollback notice before a tool row', () => {
  const messages: Message[] = [
    { role: 'tool', callId: 't1', summary: 'Ran: gh issue view 482 (2516 bytes output)' },
    {
      role: 'system',
      content: 'Shell commands run sandboxed: writes confined to ~/Git/reika, temp and cache dirs.',
    },
    { role: 'tool', callId: 't2', summary: 'Ran: gh issue view 481 (558 bytes output)' },
  ];
  const raw = (frame: string | undefined): string[] => (frame ?? '').split('\n');

  it('leaves a blank row between the notice and the next tool row', () => {
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    const lines = raw(lastFrame());
    const notice = lines.findIndex(l => l.includes('❯ Shell commands run sandboxed'));
    const nextRow = lines.findIndex(l => l.includes('↳ Ran: gh issue view 481'));
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(nextRow).toBeGreaterThan(notice);
    // Not adjacent: at least one blank display row belongs between the two.
    const between = lines.slice(notice + 1, nextRow);
    expect(between).toContain('');
  });

  it('keeps back-to-back tool rows tight when no notice intervenes', () => {
    const { lastFrame } = render(
      <Scrollback
        messages={[messages[0], messages[2]]}
        streaming=""
        streamingReasoning=""
        streamingTool=""
      />,
    );
    const lines = raw(lastFrame());
    const second = lines.findIndex(l => l.includes('↳ Ran: gh issue view 481'));
    expect(second).toBeGreaterThan(0);
    expect(lines[second - 1]).not.toBe('');
  });
});

// A result's command chip or diff ends flush against the next `↳`, which then reads as one more
// line of that output rather than a result of its own — a read after a bash chip looked like it
// came from the command (#492). Summary-only rows keep sitting tight.
describe('Scrollback tool rows after an output block', () => {
  const bash = (id: string, cmd: string): Message => ({
    role: 'tool',
    callId: id,
    summary: `Ran: ${cmd} (12 bytes output)`,
    command: { text: cmd, outputTail: 'line one\nline two', outputTruncated: false },
  });
  const read = (id: string, path: string): Message => ({
    role: 'tool',
    callId: id,
    summary: `Read ${path} (1-40 of 40)`,
  });
  const edit: Message = {
    role: 'tool',
    callId: 'e1',
    summary: 'Edited src/b.ts (+1 -1)',
    diff: { text: '- old\n+ new', path: 'src/b.ts', added: 1, removed: 1 },
  };
  const lines = (messages: Message[]): string[] => {
    const { lastFrame } = render(
      <Scrollback messages={messages} streaming="" streamingReasoning="" streamingTool="" />,
    );
    return (lastFrame() ?? '').split('\n');
  };
  const rowAbove = (ls: string[], needle: string): string => {
    const i = ls.findIndex(l => l.includes(needle));
    expect(i).toBeGreaterThan(0);
    return ls[i - 1];
  };

  it('gaps a bash result that follows another bash result', () => {
    const ls = lines([bash('b1', 'echo one'), bash('b2', 'echo two')]);
    expect(rowAbove(ls, '↳ Ran: echo two')).toBe('');
  });

  it('gaps a read that follows a command chip', () => {
    const ls = lines([bash('b1', 'echo one'), read('r1', 'src/a.ts')]);
    expect(rowAbove(ls, '↳ src/a.ts')).toBe('');
  });

  it('gaps a result that follows a diff', () => {
    const ls = lines([edit, read('r1', 'src/a.ts')]);
    expect(rowAbove(ls, '↳ src/a.ts')).toBe('');
  });

  it('gaps sequential edits', () => {
    const ls = lines([edit, { ...edit, callId: 'e2', summary: 'Edited src/d.ts (+1 -1)' }]);
    expect(rowAbove(ls, '↳ Edited src/d.ts')).toBe('');
  });

  it('gaps a blocked result that follows a summary-only row', () => {
    const ls = lines([read('r1', 'src/a.ts'), bash('b1', 'echo one')]);
    expect(rowAbove(ls, '↳ Ran: echo one')).toBe('');
  });

  it('keeps summary-only rows tight among themselves', () => {
    const ls = lines([read('r1', 'src/a.ts'), read('r2', 'src/c.ts')]);
    // Stacked, these two are exactly the case #627 labels (#627 keeps the `Read` verb on both
    // rows), so the needle is the labelled form — the point of this test is the row's *spacing*,
    // not its text.
    expect(rowAbove(ls, '↳ Read src/c.ts')).not.toBe('');
  });

  it('keeps the first result tight under its tool call', () => {
    const ls = lines([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'echo one' } }],
      },
      bash('b1', 'echo one'),
    ]);
    expect(rowAbove(ls, '↳ Ran: echo one')).not.toBe('');
  });
});

describe('markProse', () => {
  // A pre-trimmed live tail starts mid-message: its first row must hang, not claim a new step.
  it('indents without a marker when the start of the text is not in view', () => {
    expect(stripAnsi(markProse('mid-sentence tail\n\nnext para', false))).toBe(
      '  mid-sentence tail\n\n  next para',
    );
    expect(stripAnsi(markProse('start\nmore'))).toBe('⏺︎ start\n  more');
  });
});

// The plan-commit grounding note is model-facing text appended to the plan; the scrollback cuts it
// at `planChecks.at` and draws the findings as a barred block under the plan instead of prose.
describe('Scrollback plan checks', () => {
  const PLAN = '1. Edit `src/agent/loop.ts` to call `fooBar`.';
  const NOTE =
    '\n\n--- reika: plan grounding check (auto-generated) ---\nThese names in the plan were not found';
  const frame = (msg: Message) =>
    stripAnsi(
      render(
        <Scrollback messages={[msg]} streaming="" streamingReasoning="" streamingTool="" />,
      ).lastFrame() ?? '',
    );

  it('draws the findings as a block and hides the note text', () => {
    const out = frame({
      role: 'assistant',
      content: PLAN + NOTE,
      planFinal: true,
      planChecks: { at: PLAN.length, missing: ['fooBar'], deadUrls: [] },
    });
    expect(out).toContain('src/agent/loop.ts');
    expect(out).not.toContain('--- reika');
    expect(out).toMatch(/▎ Plan check/);
    expect(out).toMatch(/▎ 1 reference not found in the codebase:/);
    expect(out).toMatch(/▎ fooBar/);
  });

  it('renders a message without planChecks as before', () => {
    expect(frame({ role: 'assistant', content: PLAN + NOTE })).toContain('--- reika');
  });
});

// The live blocks are reused between renders whose inputs for that block are unchanged (a status
// clock tick, a pending-call row appearing, a dialog opening). Reuse is only safe if a changed
// input is a miss, so these pin the inputs the builders read: the text, the width the block wraps
// at, the row bound it is trimmed by, and the scrub rules the tool block bakes in. A miss that did
// not happen showed the previous frame's rows — a stale width, a tail that never grew, or a name
// the anonymization rules have since rewritten.
describe('Scrollback live-block reuse', () => {
  const withViewport = <T,>(rows: number, cols: number, fn: () => T): T => {
    const prev = { rows: process.stdout.rows, columns: process.stdout.columns };
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperties(process.stdout, {
        rows: { value: prev.rows, configurable: true },
        columns: { value: prev.columns, configurable: true },
      });
    }
  };

  const live = (reasoning: string, streaming = '', streamingTool = '') => (
    <Scrollback
      messages={[]}
      streaming={streaming}
      streamingReasoning={reasoning}
      streamingTool={streamingTool}
    />
  );

  const rows = (frame: string | undefined): string[] =>
    stripAnsi(frame ?? '')
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.trim());

  // The reasoning text object is the same one across the rerender — exactly the case the memo
  // serves. Only the terminal got wider, and that alone has to re-wrap the block.
  it('re-wraps an unchanged live block when the terminal width changes', () => {
    const reasoning =
      'I should look at the config loader on disk before touching any of the call sites at all.';
    withViewport(24, 60, () => {
      const { rerender, lastFrame } = render(live(reasoning));
      const narrow = rows(lastFrame());
      rerender(live(reasoning)); // same text, same element values
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      rerender(live(reasoning));
      const wide = rows(lastFrame());
      expect(narrow.length).toBeGreaterThan(wide.length);
      for (const row of wide) expect(row.length).toBeLessThanOrEqual(100);
    });
  });

  // The row bound comes from the viewport, and it decides how much of the tail is even built: the
  // pre-trim is `bound * 4` lines. A block built under a short terminal therefore holds a shorter
  // tail than a taller one can fill, so the bound has to be a miss, or a terminal that grows (or a
  // frame-drawing `chromeRows` shrinking) keeps the small viewport's tail.
  it('shows more of an unchanged tail when the viewport grows', () => {
    const tail = Array.from({ length: 400 }, (_, i) => `line ${i} of the streamed answer`).join(
      '\n',
    );
    withViewport(24, 80, () => {
      const { rerender, lastFrame } = render(live('', tail));
      const short = rows(lastFrame()).length;
      Object.defineProperty(process.stdout, 'rows', { value: 100, configurable: true });
      rerender(live('', tail));
      const tall = rows(lastFrame()).length;
      // A short viewport trims the tail to ~14 rows' worth (~56 lines); the taller one has room
      // for far more than that, which it can only show if the block was rebuilt.
      expect(short).toBeLessThan(20);
      expect(tall).toBeGreaterThan(56);
    });
  });

  // One block changing must not disturb the other: the Thinking block above is rebuilt for the
  // frame it shares with the answer, and its rows stay the ones its own text renders to.
  it('keeps the other block’s rows while one block streams', () => {
    const reasoning = 'Checking the loader, then editing the call sites in order.';
    withViewport(40, 80, () => {
      const { rerender, lastFrame } = render(live(reasoning, 'First part of the answer.'));
      const before = rows(lastFrame()).filter(l => l.includes('Checking the loader'));
      rerender(live(reasoning, 'First part of the answer, and now the second part.'));
      const after = rows(lastFrame()).filter(l => l.includes('Checking the loader'));
      expect(after).toEqual(before);
      expect(rows(lastFrame()).join('\n')).toContain('and now the second part');
    });
  });

  // A tool block is trimmed and wrapped too, so it carries the same rule. Both frames are capped
  // by the block's share of the region (the tail is pre-cut, so it always asks for more rows than
  // it can get), so the width shows up in how long a row is rather than in how many there are.
  it('re-wraps an unchanged tool tail when the terminal width changes', () => {
    const output = Array.from(
      { length: 40 },
      (_, i) => `make[1]: entering directory ${i} and compiling the target now`,
    ).join('\n');
    const widest = (frame: string[]): number => Math.max(...frame.map(l => l.length));
    withViewport(30, 60, () => {
      const { rerender, lastFrame } = render(live('', '', output));
      const narrow = rows(lastFrame());
      Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
      rerender(live('', '', output));
      const wide = rows(lastFrame());
      expect(widest(wide)).toBeGreaterThan(widest(narrow));
      for (const row of wide) expect(row.length).toBeLessThanOrEqual(120);
    });
  });

  // An input with no argument of its own: the paint the builders bake into their rows
  // (`markProse`'s marker, inline code, a highlighted fence — all `themeChalk`, which re-reads
  // `chalk.level` per call). A block must not outlive the level it was painted under, so the same
  // text under a new level is a miss. A one-shot render cannot see this: it needs the reuse path.
  it('re-paints an unchanged block when the color level changes', () => {
    const text = 'Here is `inline code` and a **bold** run in the streamed answer.';
    const prevLevel = chalk.level;
    try {
      // #d5afee, theme.inlineCode, as truecolor — the paint the codespan takes at level 3 and
      // that `chalk.hex` drops entirely at level 0.
      const INLINE_CODE = '\u001b[38;2;213;175;238m';
      chalk.level = 0;
      const { rerender, lastFrame } = render(live('', text));
      expect(lastFrame() ?? '').not.toContain(INLINE_CODE);
      rerender(live('', text)); // same text: the previous render is reusable…
      expect(lastFrame() ?? '').not.toContain(INLINE_CODE);
      chalk.level = 3;
      rerender(live('', text)); // …but not under a different paint level
      expect(lastFrame() ?? '').toContain(INLINE_CODE);
    } finally {
      chalk.level = prevLevel;
    }
  });

  // The other input with no argument of its own: the anonymization rules `scrubOutput` applies
  // inside the tool block (identity.ts). `/anon on|off` swaps them mid-session, and the tool tail
  // bakes the substitutions in — so a tail built before the swap must not keep showing the name
  // the user just asked to anonymize. Same text object across the rerender: only the rules moved.
  it('re-scrubs an unchanged tool tail when the anonymization rules change', () => {
    const output = 'pushed by octocat on the main branch just now';
    withViewport(30, 80, () => {
      try {
        const { rerender, lastFrame } = render(live('', '', output));
        expect(lastFrame() ?? '').toContain('octocat');
        setIdentity({ names: ['octocat'], emails: [] }); // /anon on mid-stream
        rerender(live('', '', output)); // same text: the previous render is reusable…
        const frame = lastFrame() ?? '';
        expect(frame).not.toContain('octocat'); // …but not under different rules
        expect(frame).toContain('<user>');
      } finally {
        clearIdentity();
      }
    });
  });
});
