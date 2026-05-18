import { describe, expect, it } from 'vitest';
import { stripReasoningMarkdown } from './markdown.js';

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
