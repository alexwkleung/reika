import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightCode, resolveLanguage } from './highlight.js';
import {
  hideDanglingMarkers,
  renderInlineMarkdown,
  renderMarkdown,
  renderReasoningMarkdown,
} from './markdown.js';
import { theme } from './theme.js';

describe('renderReasoningMarkdown', () => {
  it("gives reasoning the reply's structure with no styling left in it", () => {
    const out = renderReasoningMarkdown(
      '**Plan**\n\n- read `a.ts`\n- see [docs](http://example.com)\n\n```ts\nconst x = 1;\n```',
      60,
    );
    expect(out).toBe(stripAnsi(out));
    expect(out).toContain('Plan');
    expect(out).toContain('• read a.ts');
    expect(out).not.toMatch(/\*\*|`|\]\(/);
    expect(out).toContain('const x = 1;');
  });

  it("keeps a link's URL even where the terminal takes OSC 8 hyperlinks", () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    try {
      const out = renderReasoningMarkdown('see [the docs](https://example.com/a) here', 60);
      expect(out).toBe('see the docs (https://example.com/a) here');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('hideDanglingMarkers', () => {
  it('holds back an unclosed bold or code opener on the last line', () => {
    expect(hideDanglingMarkers('Let me check **the loo')).toBe('Let me check the loo');
    expect(hideDanglingMarkers('**done** and `foo')).toBe('**done** and foo');
    expect(hideDanglingMarkers('1. *Step')).toBe('1. Step');
  });

  it('holds back a trailing half-streamed marker', () => {
    expect(hideDanglingMarkers('check *')).toBe('check ');
    expect(hideDanglingMarkers('check **')).toBe('check ');
    expect(hideDanglingMarkers('*')).toBe('');
  });

  it('leaves balanced markers, arithmetic and list markers alone', () => {
    for (const s of ['**a** and *b* and `c`', '2 * 3 = 6', '* item', '  * nested item']) {
      expect(hideDanglingMarkers(s)).toBe(s);
    }
  });

  it('does not count stars inside a code span', () => {
    expect(hideDanglingMarkers('use `a ** b` here')).toBe('use `a ** b` here');
    expect(hideDanglingMarkers('use `**kwargs')).toBe('use **kwargs');
  });

  it('shows only the text of a link still streaming', () => {
    expect(hideDanglingMarkers('see [the docs](https://ex')).toBe('see the docs');
    expect(hideDanglingMarkers('see [the do')).toBe('see the do');
    expect(hideDanglingMarkers('see [the docs]')).toBe('see the docs');
    expect(hideDanglingMarkers('see [docs](http://x.y) now')).toBe('see [docs](http://x.y) now');
    expect(hideDanglingMarkers('read arr[i')).toBe('read arr[i');
  });

  it('only touches the last line', () => {
    expect(hideDanglingMarkers('an **odd line\nnext **one')).toBe('an **odd line\nnext one');
  });

  it('hides a fence line until its newline, at either end of the block', () => {
    const block = 'Plan:\n```ts\nxxx\n```\ndone';
    for (let i = 1; i <= block.length; i++) {
      const out = renderReasoningMarkdown(hideDanglingMarkers(block.slice(0, i)), 60);
      expect(out, JSON.stringify(block.slice(0, i))).not.toContain('`');
    }
    expect(hideDanglingMarkers('a\n``ts')).toBe('a\n');
    expect(hideDanglingMarkers('a\n```\nx\n``')).toBe('a\n```\nx\n');
  });

  it('leaves a code span that opens a line alone', () => {
    expect(hideDanglingMarkers('``a`b`` is code')).toBe('``a`b`` is code');
    expect(hideDanglingMarkers('`foo')).toBe('foo');
  });

  it('leaves the text alone inside an open fence', () => {
    const s = '```py\ndef f(**kwargs';
    expect(hideDanglingMarkers(s)).toBe(s);
  });
});

describe('renderInlineMarkdown', () => {
  it('styles inline markers without leaving raw syntax and stays single-line', () => {
    const out = renderInlineMarkdown('Add `favorites` to **PlayerState** in `src/state.ts`');
    expect(out).toContain('favorites');
    expect(out).toContain('src/state.ts');
    expect(out).not.toContain('`');
    expect(out).not.toContain('**');
    expect(out).not.toContain('\n');
  });

  it('keeps colons inside codespans', () => {
    const out = renderInlineMarkdown('read `src/a.ts:120` first');
    expect(out).toContain('src/a.ts:120');
  });

  it('leaves plain text unchanged', () => {
    expect(renderInlineMarkdown('just plain text')).toBe('just plain text');
  });
});

describe('renderMarkdown lists', () => {
  it('renders unordered bullets as • not literal *', () => {
    const out = renderMarkdown('Title:\n\n* one\n* two');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
    expect(out).not.toContain('* one');
  });

  it('numbers ordered list items', () => {
    const out = renderMarkdown('Steps:\n\n1. first\n2. second\n3. third');
    expect(out).toContain('1. first');
    expect(out).toContain('2. second');
    expect(out).toContain('3. third');
    expect(out).not.toContain('* first');
  });

  it('keeps a single blank line between a paragraph and a following list', () => {
    const out = renderMarkdown('Title:\n\n* one\n* two');
    // One blank line (\n\n), not the doubled \n\n\n the old override produced.
    expect(out).toContain('Title:\n\n  • one');
    expect(out).not.toContain('\n\n\n');
  });

  it('recognizes a list even without a blank line before it', () => {
    const out = renderMarkdown('Title:\n* one\n* two');
    expect(out).toContain('• one');
    expect(out).not.toContain('* one');
  });

  it('leaves asterisks inside code blocks untouched', () => {
    const out = renderMarkdown('code:\n\n```c\nint x = 2 * 3;\n```');
    expect(out).toContain('2 * 3');
    expect(out).not.toContain('2 • 3');
  });

  it('keeps colons inside inline code within a list item', () => {
    const out = renderMarkdown('- Run `http://localhost:3000` now');
    expect(out).toContain('http://localhost:3000');
  });

  it('keeps colons inside ordered-list inline code', () => {
    const out = renderMarkdown('1. `git:status`\n2. plain');
    expect(out).toContain('git:status');
  });
});

describe('renderMarkdown links', () => {
  it('renders the link text and href, never `undefined`', () => {
    const out = renderMarkdown('see [the docs](https://example.com/docs) here');
    expect(out).not.toContain('undefined');
    expect(out).toContain('the docs');
    expect(out).toContain('https://example.com/docs');
  });

  // chalk.level is 0 under vitest (non-TTY), which strips every style — force colors on so the
  // assertions below see the escape codes.
  const savedLevel = chalk.level;
  afterEach(() => {
    chalk.level = savedLevel;
  });

  it('paints a bare URL in the link color, not dim (#397)', () => {
    chalk.level = 3;
    const out = renderMarkdown('see https://example.com/docs here');
    expect(out).toContain(chalk.hex(theme.link)('https://example.com/docs'));
    expect(out).not.toContain('\u001b[2m'); // dim, the old style
  });

  it('paints the href of a markdown link the same way', () => {
    chalk.level = 3;
    const out = renderMarkdown('see [the docs](https://example.com/docs) here');
    expect(out).toContain(chalk.hex(theme.link)('https://example.com/docs'));
    expect(out).not.toContain('\u001b[2m');
  });

  // Under vitest stdout is a pipe, so the default is the no-hyperlink branch (the assertions
  // above rely on that). FORCE_HYPERLINK=1 is supports-hyperlinks' override, re-read per render.
  it('does not underline where the terminal has no OSC 8 hyperlinks', () => {
    chalk.level = 3;
    const out = renderMarkdown('see https://example.com/docs here');
    expect(out).not.toContain('\u001b[4m');
  });

  it('underlines where the terminal takes OSC 8 hyperlinks', () => {
    chalk.level = 3;
    vi.stubEnv('FORCE_HYPERLINK', '1');
    try {
      const out = renderMarkdown('see https://example.com/docs here');
      expect(out).toContain(chalk.hex(theme.link).underline('https://example.com/docs'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows only the text of a markdown link, as an OSC 8 hyperlink to the href', () => {
    chalk.level = 3;
    vi.stubEnv('FORCE_HYPERLINK', '1');
    try {
      const out = renderMarkdown('see [the docs](https://example.com/a+b) here');
      const text = chalk.hex(theme.link).underline('the docs');
      expect(out).toBe(`see \u001b]8;;https://example.com/a+b\u0007${text}\u001b]8;;\u0007 here`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('renderMarkdown hard line breaks', () => {
  it('breaks the line on two trailing spaces', () => {
    expect(renderMarkdown('first line  \nsecond line')).toBe('first line\nsecond line');
  });

  it('breaks the line on a trailing backslash', () => {
    expect(renderMarkdown('first line\\\nsecond line')).toBe('first line\nsecond line');
  });

  it('still joins a soft break', () => {
    expect(renderMarkdown('first line \nsecond line')).toBe('first line second line');
  });
});

describe('renderMarkdown blockquotes', () => {
  it('draws a left border instead of an indent', () => {
    const out = renderMarkdown('> quoted line');
    expect(out).toBe('│ quoted line');
  });

  it('keeps the border continuous across a blank line between quoted paragraphs', () => {
    const out = renderMarkdown('> first\n>\n> second');
    expect(out).toBe('│ first\n│\n│ second');
  });

  it('stacks the bar on nested quotes', () => {
    const out = renderMarkdown('> outer\n>\n> > inner');
    expect(out).toBe('│ outer\n│\n│ │ inner');
  });

  it('separates the quote from surrounding paragraphs with one blank line', () => {
    const out = renderMarkdown('before\n\n> quote\n\nafter');
    expect(out).toBe('before\n\n│ quote\n\nafter');
  });

  it('keeps every bullet of a quoted list at the same column', () => {
    const out = renderMarkdown('> - one\n> - two');
    const [first, second] = out.split('\n');
    expect(first).toBe('│   • one');
    expect(second).toBe('│   • two');
  });

  it('still runs inline renderers inside the quote', () => {
    const out = renderMarkdown('> see `a:b` and **bold**');
    expect(out).toContain('a:b');
    expect(out).toContain('bold');
    expect(out).not.toContain('**');
  });
});

describe('renderMarkdown tables', () => {
  const table = '| Flag | Default |\n| --- | --- |\n| `REIKA_WARM` | off |';

  const savedLevel = chalk.level;
  afterEach(() => {
    chalk.level = savedLevel;
  });

  it('renders header cells bold white, not cyan', () => {
    chalk.level = 3;
    const out = renderMarkdown(table);
    expect(out).toContain('\u001b[1m\u001b[37m'); // bold + white opener on the header row
    expect(out).not.toContain('\u001b[36m'); // cyan, the old header color
  });

  it('keeps the header text intact', () => {
    const out = renderMarkdown(table);
    expect(out).toContain('Flag');
    expect(out).toContain('Default');
    expect(out).toContain('REIKA_WARM');
  });

  // #439: a table laid out at its natural content width left any line past the pane for Ink
  // to wrap — which tore the borders mid-glyph.
  const wide = [
    '| File | Resolution |',
    '| --- | --- |',
    "| src/config.ts | Kept main's '8' + the \"last round IS the report round (#340)\" comment; re-added visionModel / visionBaseURL / visionApiKey below it |",
    '| .env.example | Same — main also lowered the shipped example 500→8; kept 8, vision block below it |',
  ].join('\n');

  it('fits a wide table inside the block width', () => {
    for (const line of stripAnsi(renderMarkdown(wide, 60)).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it('keeps every row the same width so the borders line up', () => {
    const rows = stripAnsi(renderMarkdown(wide, 60))
      .split('\n')
      .filter(line => line.length > 0);
    expect(new Set(rows.map(line => line.length)).size).toBe(1);
  });

  it('wraps the long column rather than overflowing it', () => {
    const out = stripAnsi(renderMarkdown(wide, 60));
    // The prose column continues onto further `│ … │` rows instead of running off the edge.
    expect(out.split('\n').filter(line => line.startsWith('│')).length).toBeGreaterThan(4);
    expect(out).toContain('│ Kept main');
  });

  it('leaves a table that already fits untouched', () => {
    expect(stripAnsi(renderMarkdown(table, 80))).toBe(stripAnsi(renderMarkdown(table, 120)));
  });

  it('honors column alignment', () => {
    const out = stripAnsi(
      renderMarkdown('| n | name |\n| --: | :-: |\n| 7 | ab |\n| 100 | abcdef |'),
    );
    expect(out).toContain('│   7 │   ab   │');
    expect(out).toContain('│ 100 │ abcdef │');
  });

  it('splits a word longer than its cell rather than dropping it', () => {
    const long = 'x'.repeat(80);
    const out = stripAnsi(renderMarkdown(`| k | v |\n| - | - |\n| a | ${long} |`, 40));
    expect(out.replace(/[│\s]/g, '')).toContain('a' + long);
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('fits a table nested in a list within the block width', () => {
    const nested = `- item:\n\n  ${wide.split('\n').join('\n  ')}\n`;
    for (const line of stripAnsi(renderMarkdown(nested, 60)).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  // A cell holding a bare `✔` measures two columns to string-width and draws in one, so padding
  // it by the measurement left the row a column short of its own borders and the right edge
  // stepped in — on the rows with a check mark in them, which is where a table of test results
  // shows it. Cells are padded by `drawnWidth` now, and the columns that costs Ink come out of
  // the fit budget.
  const ticks = [
    '| File | Result |',
    '| --- | --- |',
    '| src/ui/markdown.ts | borders square ✔ |',
    '| src/ui/Scrollback.tsx | untouched |',
  ].join('\n');

  it('draws every row of a table the same width when a cell holds a one-cell ✔', () => {
    for (const width of [30, 46, 60, 120]) {
      const rows = stripAnsi(renderMarkdown(ticks, width))
        .split('\n')
        .filter(line => line.length > 0);
      // `✔` is one column on a terminal, so code points ARE columns in these rows — and the
      // border row drawn from the same `widths` has to come out the same length as the cell rows.
      expect(new Set(rows.map(line => [...line].length)).size).toBe(1);
    }
  });

  it('keeps the slack a padded cell costs Ink inside the block width', () => {
    // Ink re-wraps any row that measures past the pane, which would tear the border it just lined
    // up — the #439 failure. Every width here is also one the table has to shrink to fit.
    for (let width = 24; width <= 80; width++) {
      for (const line of renderMarkdown(ticks, width).split('\n')) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('unsupported fence languages', () => {
  // Highlighting is skipped entirely at chalk.level 0 (non-TTY test run), which
  // would make these tests vacuous — force colors on.
  const savedLevel = chalk.level;
  afterEach(() => {
    chalk.level = savedLevel;
    vi.restoreAllMocks();
  });

  it('renders an unknown language without console spam or the yellow fallback', () => {
    chalk.level = 3;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = renderMarkdown('```astro\n<button onclick={() => toggle()}>x</button>\n```');
    // highlight.js console.error()s "Could not find the language …" before
    // throwing; Ink folds that into the frame as chat spam.
    expect(consoleError).not.toHaveBeenCalled();
    expect(out).toContain('toggle()');
    expect(out).not.toContain('[33m');
  });

  it('highlightCode falls back to plaintext for unknown languages without console spam', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = highlightCode('const x = 1;', 'astro');
    expect(consoleError).not.toHaveBeenCalled();
    expect(out).toContain('const x = 1;');
  });

  it('resolveLanguage keeps supported names, rewrites unknown and missing ones to plaintext', () => {
    expect(resolveLanguage('ts')).toBe('ts');
    expect(resolveLanguage('astro')).toBe('plaintext');
    expect(resolveLanguage('')).toBe('plaintext');
    expect(resolveLanguage(undefined)).toBe('plaintext');
  });

  it('leaves an unlabeled fence plain rather than guessing a language', () => {
    chalk.level = 3;
    expect(renderMarkdown('```\nSELECT * FROM t;\n```')).toBe('SELECT * FROM t;');
  });
});

// Issue #154, fourth surface. A model answering about Go or a Makefile emits tab-indented code
// fences, and a renderer passes tabs straight through. Ink measures a tab as zero columns and
// the terminal draws it as eight, so the live block's row budget — the guard that keeps the
// dynamic frame under the viewport height — undercounts exactly the lines that are widest.
describe('markdown terminal-unsafe characters', () => {
  const TAB = '\t';

  it('flattens tabs inside a code fence', () => {
    const md = ['```go', 'func main() {', `${TAB}if ok {`, `${TAB}${TAB}run()`, '}', '```'].join(
      '\n',
    );
    const out = renderMarkdown(md);
    expect(out).not.toContain(TAB);
    expect(out).toContain('run()');
  });

  it('keeps code-fence indentation proportional after flattening', () => {
    const md = ['```go', `${TAB}one`, `${TAB}${TAB}two`, '```'].join('\n');
    const lines = renderMarkdown(md).split('\n');
    const one = lines.find(l => l.includes('one'))!;
    const two = lines.find(l => l.includes('two'))!;
    expect(two.indexOf('two')).toBeGreaterThan(one.indexOf('one'));
  });

  it('flattens tabs in reasoning text', () => {
    expect(renderReasoningMarkdown(`plan:${TAB}step one`, 60)).not.toContain(TAB);
  });

  it('leaves ordinary prose unchanged', () => {
    expect(renderMarkdown('Just a **sentence** with `code`.')).toContain('sentence');
  });
});

// Every rendered line has to fit the App's content width (columns minus the paddingX gutter),
// or Ink hard-wraps the last word onto a row of its own. Lists were the exposure: tight items
// kept the model's own soft line breaks unreflowed and then took the list tab, loose items
// were reflowed at the full width and then indented by tab + marker.
describe('renderMarkdown wraps to the content width', () => {
  const COLS = 60;
  const CONTENT = COLS - 2;
  const setColumns = (value: number | undefined) =>
    Object.defineProperty(process.stdout, 'columns', { value, configurable: true });
  const prev = process.stdout.columns;
  afterEach(() => setColumns(prev));

  const widths = (out: string) => out.split('\n').map(l => l.length);
  const LONG = 'the quick brown fox jumps over the lazy dog again and again and again';

  it('reflows a tight list item across the model’s own soft line breaks', () => {
    setColumns(COLS);
    // A model that hard-wraps its prose at the pane width, plus the list tab, overflowed by two.
    const line = 'Guinness World Record: In 2011, they were recognized for the';
    const out = renderMarkdown(`7. ${line}\n   most followers at the time.\n8. next item`);
    expect(Math.max(...widths(out))).toBeLessThanOrEqual(CONTENT);
    expect(out).not.toContain('the\n'); // the model's own break is gone
    expect(out).toContain('  8. next item');
  });

  it('keeps every line of a loose list inside the content width', () => {
    setColumns(COLS);
    const out = renderMarkdown(`- ${LONG}\n\n- ${LONG}`);
    expect(Math.max(...widths(out))).toBeLessThanOrEqual(CONTENT);
  });

  it('hangs continuation lines under the item text', () => {
    setColumns(COLS);
    const [first, second] = renderMarkdown(`10. ${LONG}`).split('\n');
    expect(first.startsWith('  10. ')).toBe(true);
    expect(second.startsWith('      ')).toBe(true);
    expect(second.charAt(6)).not.toBe(' ');
  });

  it('puts a nested list on its own lines, narrower still', () => {
    setColumns(COLS);
    const out = renderMarkdown(`- parent\n  - ${LONG}\n- sibling`);
    const lines = out.split('\n');
    expect(lines[0]).toBe('  • parent');
    expect(lines[1].startsWith('    • ')).toBe(true);
    expect(Math.max(...widths(out))).toBeLessThanOrEqual(CONTENT);
    expect(lines.at(-1)).toBe('  • sibling');
  });

  it('accounts for the blockquote bar', () => {
    setColumns(COLS);
    const out = renderMarkdown(`> ${LONG}`);
    expect(Math.max(...widths(out))).toBeLessThanOrEqual(CONTENT);
    expect(out.split('\n').every(l => l.startsWith('│ '))).toBe(true);
  });

  it('reads the terminal width at render time, not import time', () => {
    setColumns(COLS);
    const narrow = Math.max(...widths(renderMarkdown(LONG)));
    setColumns(120);
    const wide = Math.max(...widths(renderMarkdown(LONG)));
    expect(narrow).toBeLessThanOrEqual(CONTENT);
    expect(wide).toBe(LONG.length);
  });

  // #431: a nested row (subagent reply, compaction note) is narrower than the terminal-derived
  // default, and a caller that knows its block's width passes it. Paragraphs and list bodies
  // both wrap to it; the list's own tab and marker still come out of the same columns.
  it('wraps to an explicit width instead of the terminal’s', () => {
    setColumns(120);
    const NESTED = CONTENT - 4;
    const prose = renderMarkdown(`${LONG} ${LONG}`, NESTED);
    expect(Math.max(...widths(prose))).toBeLessThanOrEqual(NESTED);
    expect(Math.max(...widths(prose))).toBeGreaterThan(NESTED - 12); // wrapped there, not narrower
    const list = renderMarkdown(`- ${LONG} ${LONG}\n- ${LONG}`, NESTED);
    expect(Math.max(...widths(list))).toBeLessThanOrEqual(NESTED);
    expect(list.split('\n')[1].startsWith('    ')).toBe(true);
  });

  it('falls back to the terminal width when no width is given', () => {
    setColumns(COLS);
    expect(renderMarkdown(LONG)).toBe(renderMarkdown(LONG, CONTENT));
  });
});
