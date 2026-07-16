import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightCode, resolveLanguage } from './highlight.js';
import { renderInlineMarkdown, renderMarkdown, stripReasoningMarkdown } from './markdown.js';

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
