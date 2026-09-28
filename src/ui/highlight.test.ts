import chalk from 'chalk';
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

  it('leaves code alone with colors off', () => {
    chalk.level = 0;
    expect(highlightCode('const x = 1;', 'ts')).toBe('const x = 1;');
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
