import { describe, expect, it } from 'vitest';
import { buildEditDiff, buildWriteDiff, editDiffStartLine } from './_diff.js';

describe('buildEditDiff', () => {
  it('shows actual changes with surrounding context', () => {
    const oldStr = 'const x = 10;';
    const newStr = 'const x = 20;';
    const diff = buildEditDiff(oldStr, newStr, 'before line\n', '\nafter line');
    expect(diff).toContain('  before line');
    expect(diff).toContain('- const x = 10;');
    expect(diff).toContain('+ const x = 20;');
    expect(diff).toContain('  after line');
  });

  it('renders unchanged lines within the edit block as context, not -/+', () => {
    // old has 3 lines, new has 4 lines (one added in the middle), 3 lines are identical
    const oldStr = ['import { a } from "./a.js";', '', 'const X = 1;'].join('\n');
    const newStr = ['import { a } from "./a.js";', '', 'const Y = 2;  // new', 'const X = 1;'].join(
      '\n',
    );
    const diff = buildEditDiff(oldStr, newStr, '', '');

    // Identical import line should appear as context (`  `), not as both `-` and `+`
    expect(diff).toContain('  import { a } from "./a.js";');
    expect(diff).not.toContain('- import { a } from "./a.js";');
    expect(diff).not.toContain('+ import { a } from "./a.js";');

    // The actually-added line should appear as `+`
    expect(diff).toContain('+ const Y = 2;  // new');

    // The unchanged `const X = 1;` line should be context too
    expect(diff).toContain('  const X = 1;');
  });

  it('shows replacements as paired - / + when no line matches across sides', () => {
    const oldStr = 'foo(bar)';
    const newStr = 'foo(baz)';
    const diff = buildEditDiff(oldStr, newStr, '', '');
    expect(diff).toContain('- foo(bar)');
    expect(diff).toContain('+ foo(baz)');
  });

  it('handles pure deletion (new is shorter)', () => {
    const oldStr = 'a\nb\nc';
    const newStr = 'a\nc';
    const diff = buildEditDiff(oldStr, newStr, '', '');
    expect(diff).toContain('  a');
    expect(diff).toContain('- b');
    expect(diff).toContain('  c');
  });

  it('handles pure insertion (new is longer)', () => {
    const oldStr = 'a\nc';
    const newStr = 'a\nb\nc';
    const diff = buildEditDiff(oldStr, newStr, '', '');
    expect(diff).toContain('  a');
    expect(diff).toContain('+ b');
    expect(diff).toContain('  c');
  });
});

describe('editDiffStartLine', () => {
  it('is 1 when the edit is at the top of the file', () => {
    expect(editDiffStartLine('')).toBe(1);
  });

  it('accounts for the context lines shown above the match', () => {
    // 246 lines precede the match (trailing newline => match begins on line 247).
    // The diff shows 3 context lines above it, so it starts at line 244.
    const before = Array.from({ length: 246 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    expect(editDiffStartLine(before)).toBe(244);
  });

  it('clamps context when fewer than 3 lines precede the match', () => {
    // Match begins on line 2; only 1 context line can be shown above it.
    expect(editDiffStartLine('line 1\n')).toBe(1);
  });
});

describe('buildWriteDiff', () => {
  it('renders every line as +', () => {
    const diff = buildWriteDiff('line one\nline two\nline three');
    expect(diff).toBe('+ line one\n+ line two\n+ line three');
  });

  it('strips trailing newline', () => {
    const diff = buildWriteDiff('a\nb\n');
    expect(diff).toBe('+ a\n+ b');
  });
});
