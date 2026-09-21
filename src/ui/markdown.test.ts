import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightCode, resolveLanguage } from './highlight.js';
import { renderInlineMarkdown, renderMarkdown, stripReasoningMarkdown } from './markdown.js';
import { theme } from './theme.js';

describe('stripReasoningMarkdown', () => {
  it('strips bold markers', () => {
    expect(stripReasoningMarkdown('This is **bold** text')).toBe('This is bold text');
  });

  it('strips italic markers', () => {
    expect(stripReasoningMarkdown('This is *italic* text')).toBe('This is italic text');
  });

  it('strips inline code backticks', () => {
    expect(stripReasoningMarkdown('Call `foo()` to start')).toBe('Call foo() to start');
  });

  it('strips heading prefixes', () => {
    expect(stripReasoningMarkdown('# Heading\nbody')).toBe('Heading\nbody');
    expect(stripReasoningMarkdown('### h3 here')).toBe('h3 here');
  });

  it('leaves plain text unchanged', () => {
    expect(stripReasoningMarkdown('just plain text')).toBe('just plain text');
  });

  it('handles mixed markers in one line', () => {
    expect(stripReasoningMarkdown('**bold** and *italic* and `code`')).toBe(
      'bold and italic and code',
    );
  });

  it('does not strip ** inside text without closing', () => {
    expect(stripReasoningMarkdown('open ** but no close')).toBe('open ** but no close');
  });

  it('leaves links as-is (no link syntax handling)', () => {
    expect(stripReasoningMarkdown('see [docs](url) here')).toBe('see [docs](url) here');
  });

  it('partially degrades fenced code blocks (rare in reasoning, acceptable result)', () => {
    // codespan regex catches the innermost backtick pair; outer backticks stay
    const result = stripReasoningMarkdown('```ts\nconst x = 1\n```');
    expect(result).toContain('``'); // some backticks remain — readable as "code-like"
    expect(result).not.toContain('```'); // the triple opener/closer gets partially eaten
  });

  it('does not confuse italic regex with bold (no false match on **)', () => {
    expect(stripReasoningMarkdown('**hello**')).toBe('hello');
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

  it('restores colons inside codespans (no leaked sentinel)', () => {
    const out = renderInlineMarkdown('read `src/a.ts:120` first');
    expect(out).toContain('src/a.ts:120');
    expect(out).not.toContain('COLON');
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

  it('renders colons inside inline code within a list item (no *#COLON|* leak)', () => {
    const out = renderMarkdown('- Run `http://localhost:3000` now');
    expect(out).toContain('http://localhost:3000');
    expect(out).not.toContain('*#COLON|*');
  });

  it('does not leak the colon sentinel for ordered-list inline code', () => {
    const out = renderMarkdown('1. `git:status`\n2. plain');
    expect(out).toContain('git:status');
    expect(out).not.toContain('*#COLON|*');
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
  // above rely on that). FORCE_HYPERLINK=1 is supports-hyperlinks' override; our href check
  // re-reads it per call. marked-terminal's own copy is cached at import, so the OSC 8 wrapper
  // itself never shows up here — only our half of the "underline iff OSC 8" pairing is testable.
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
    // marked-terminal's stock renderer trim()s the body before indenting, which eats the
    // first bullet's own list indent and left it two columns off from the rest.
    const out = renderMarkdown('> - one\n> - two');
    const [first, second] = out.split('\n');
    expect(first).toBe('│   • one');
    expect(second).toBe('│   • two');
  });

  it('still runs inline renderers inside the quote', () => {
    const out = renderMarkdown('> see `a:b` and **bold**');
    expect(out).toContain('a:b');
    expect(out).toContain('bold');
    expect(out).not.toContain('*#COLON|*');
    expect(out).not.toContain('**');
  });
});

describe('renderMarkdown tables', () => {
  const table = '| Flag | Default |\n| --- | --- |\n| `REIKA_WARM` | off |';

  it('renders header cells bold white, not cyan', () => {
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
});

describe('unsupported fence languages', () => {
  // marked-terminal skips highlighting entirely at chalk.level 0 (non-TTY test
  // run), which would make these tests vacuous — force colors on.
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
    // marked-terminal's catch fallback paints the whole block chalk.yellow.
    expect(out).not.toContain('[33m');
  });

  it('highlightCode falls back to plaintext for unknown languages without console spam', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = highlightCode('const x = 1;', 'astro');
    expect(consoleError).not.toHaveBeenCalled();
    expect(out).toContain('const x = 1;');
  });

  it('resolveLanguage keeps supported names and auto-detect, rewrites unknown ones', () => {
    expect(resolveLanguage('ts')).toBe('ts');
    expect(resolveLanguage('astro')).toBe('plaintext');
    expect(resolveLanguage('')).toBe('');
    expect(resolveLanguage(undefined)).toBe('');
  });
});

// Issue #154, fourth surface. A model answering about Go or a Makefile emits tab-indented code
// fences, and marked-terminal passes tabs straight through. Ink measures a tab as zero columns and
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
    expect(stripReasoningMarkdown(`plan:${TAB}step one`)).not.toContain(TAB);
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
