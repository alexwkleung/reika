import chalk from 'chalk';
import hljs from 'highlight.js/lib/common';
import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { highlightCode } from './highlight.js';
import { renderMarkdown } from './markdown.js';

// Colors are off under vitest (non-TTY), and highlighting is skipped entirely there.
const savedLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = savedLevel;
});

// Built per use: chalk resolves a hex color to escape codes for the level it was created at.
const KEYWORD = (s: string) => chalk.hex('#d68cd6')(s);
const CLASS = (s: string) => chalk.hex('#e5d49a')(s);
const TITLE = (s: string) => chalk.hex('#b4aee0')(s);
const STRING = (s: string) => chalk.hex('#9fd49f')(s);

describe('highlightCode', () => {
  it('returns the source text unchanged under the colors', () => {
    const code = 'const a = `x${b}` < 3 && "q" !== \'r\'; // <tag> & done';
    expect(stripAnsi(highlightCode(code, 'ts'))).toBe(code);
  });

  it('colors a scope by its most specific entry', () => {
    expect(highlightCode('f(x)', 'js')).toContain(TITLE('f')); // title.function.invoke
    expect(highlightCode('class A {}', 'ts')).toContain(CLASS('A')); // title.class
  });

  it('falls back to the parent scope when a sub-scope has no entry', () => {
    // title.class.inherited has no entry of its own: it takes title.class.
    expect(highlightCode('class A extends B {}', 'ts')).toContain(CLASS('B'));
  });

  it('resumes the outer color after a nested span closes', () => {
    // C's #include is a meta span holding a keyword and a string; each keeps its own color.
    const out = highlightCode('#include <x.h>', 'c');
    expect(out).toContain(KEYWORD('include'));
    expect(out).toContain(STRING('<x.h>'));
  });

  // Downsampled, the pastel tones all land on white; 16 colors get named ones instead.
  it('keeps keywords, types and strings apart on a 16-color terminal', () => {
    chalk.level = 1;
    const out = highlightCode('class A { f() { return "s"; } }', 'ts');
    expect(out).toContain(chalk.magentaBright('class'));
    expect(out).toContain(chalk.yellowBright('A'));
    expect(out).toContain(chalk.green('"s"'));
  });

  it('leaves code alone with colors off', () => {
    chalk.level = 0;
    expect(highlightCode('const x = 1;', 'ts')).toBe('const x = 1;');
  });
});

// `htmlToAnsi` parses highlight.js' HTML with one regex and unescapes five entities by hand, so
// that output format is a contract reika depends on and highlight.js does not promise: a walker
// drops whatever it cannot match instead of raising, so a changed format mis-paints silently.
// HTMLRenderer writes its buffer in exactly three places — `escapeHTML(text)`, `SPAN_CLOSE`, and
// `<span class="…">` — so this pins that alphabet, and the five escapes, against a future release.
describe('the highlight.js output that htmlToAnsi parses', () => {
  const ESCAPES = new Set(['&amp;', '&lt;', '&gt;', '&quot;', '&#x27;']);
  // Tiered scopes (`hljs-title function_ invoke__`), a bare sublanguage class (`language-js`),
  // and a meta scope wrapping a keyword and a string.
  const CASES: [string, string][] = [
    ['ts', 'const a = `x${b}` < 3 && "q" !== \'r\'; // <tag> & done'],
    ['c', '#include <x.h>'],
    ['html', '<div class="a">x</div><script>let y = 1;</script>'],
    ['bash', 'echo "hi" > out # comment'],
    ['python', 'def f(x: int) -> str: return f"{x}"'],
  ];

  it.each(CASES)('is spans, closers and the five escapes only: %s', (language, code) => {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    // A tag the regex cannot match — an added attribute, a self-closing span — survives this
    // strip whole, so a leftover `<` is the failure.
    const rest = html.replace(/<span class="[^"]*">|<\/span>/g, '');
    expect(rest).not.toMatch(/[<>]/);
    const escapes = rest.match(/&[#a-zA-Z0-9]+;/g) ?? [];
    expect(escapes.filter(e => !ESCAPES.has(e))).toEqual([]);
  });
});

describe('fenced code in markdown', () => {
  it('takes the language from the first word of the info string', () => {
    const out = renderMarkdown('```ts title="a.ts"\nconst x = 1;\n```');
    expect(out).toContain(KEYWORD('const'));
  });

  it('draws the code flush with the prose, without fence lines', () => {
    const out = stripAnsi(renderMarkdown('before\n\n```ts\nconst x = 1;\n```\n\nafter'));
    expect(out).toBe('before\n\nconst x = 1;\n\nafter');
  });
});
