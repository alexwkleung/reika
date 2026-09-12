import { describe, expect, it } from 'vitest';
import { parseDiffBlocks, diffStats, assignLineNumbers, sanitizeDiffLines } from './DiffView.js';

describe('parseDiffBlocks', () => {
  it('returns context-only blocks when no changes', () => {
    const blocks = parseDiffBlocks(['  context line 1', '  context line 2']);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: 'context', line: '  context line 1' });
    expect(blocks[1]).toEqual({ kind: 'context', line: '  context line 2' });
  });

  it('groups consecutive - and + lines into one change block', () => {
    const blocks = parseDiffBlocks([
      '  before',
      '- old line 1',
      '- old line 2',
      '+ new line 1',
      '+ new line 2',
      '  after',
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: 'context', line: '  before' });
    expect(blocks[1]).toEqual({
      kind: 'change',
      removed: ['old line 1', 'old line 2'],
      added: ['new line 1', 'new line 2'],
    });
    expect(blocks[2]).toEqual({ kind: 'context', line: '  after' });
  });

  it('handles + only (write tool — net new lines, no removed)', () => {
    const blocks = parseDiffBlocks(['+ line 1', '+ line 2', '+ line 3']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'change',
      removed: [],
      added: ['line 1', 'line 2', 'line 3'],
    });
  });

  it('handles - only (no replacement, e.g., pure deletion)', () => {
    const blocks = parseDiffBlocks(['- gone line']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'change',
      removed: ['gone line'],
      added: [],
    });
  });

  it('handles asymmetric counts (more removed than added, or vice versa)', () => {
    const blocks = parseDiffBlocks(['- a', '- b', '- c', '+ x']);
    expect(blocks[0]).toEqual({
      kind: 'change',
      removed: ['a', 'b', 'c'],
      added: ['x'],
    });
  });

  it('handles multiple change blocks separated by context', () => {
    const blocks = parseDiffBlocks([
      '- first removal',
      '+ first addition',
      '  context between',
      '- second removal',
      '+ second addition',
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe('change');
    expect(blocks[1].kind).toBe('context');
    expect(blocks[2].kind).toBe('change');
  });
});

describe('sanitizeDiffLines', () => {
  it('keeps the marker on a blank added line (issue #165)', () => {
    // The line the write tool emits for an empty line in the file. Sanitizing the composed line
    // trimmed the trailing blank off the marker, so it parsed as context and rendered indented and
    // untinted in the middle of a green block.
    const lines = sanitizeDiffLines('+ interface Props {\n+ }\n+ \n+ const x = 1;');
    expect(lines[2]).toBe('+ ');
    expect(parseDiffBlocks(lines)).toEqual([
      { kind: 'change', removed: [], added: ['interface Props {', '}', '', 'const x = 1;'] },
    ]);
  });

  it('keeps the marker on blank removed and context lines too', () => {
    expect(sanitizeDiffLines('- \n  ')).toEqual(['- ', '  ']);
  });

  it('reduces a whitespace-only changed line to a blank one', () => {
    expect(sanitizeDiffLines('+   \t ')).toEqual(['+ ']);
  });

  it('still flattens tabs, measured from the start of the line', () => {
    // Content-relative stops, as an editor shows them — not two columns into our own prefix.
    expect(sanitizeDiffLines('+ \tfoo\n  \tbar\n- \t\tbaz')).toEqual([
      `+ ${' '.repeat(8)}foo`,
      `  ${' '.repeat(8)}bar`,
      `- ${' '.repeat(16)}baz`,
    ]);
  });

  it('strips escape sequences from content', () => {
    expect(sanitizeDiffLines('+ \u001b[31mred\u001b[0m')).toEqual(['+ red']);
  });
});

describe('assignLineNumbers', () => {
  it('numbers context and changes like an editor numbers the file', () => {
    const blocks = parseDiffBlocks(['  before', '- old line', '+ new line', '  after']);
    // First diff line is file line 244.
    const { lines, maxLineNo } = assignLineNumbers(blocks, 244);
    expect(lines.map(l => [l.kind, l.lineNo])).toEqual([
      ['context', 244],
      ['paired', 245], // removed — old-file line 245
      ['paired', 245], // added — new-file line 245
      ['context', 246],
    ]);
    expect(maxLineNo).toBe(246);
  });

  it('advances old and new counters independently for asymmetric blocks', () => {
    const blocks = parseDiffBlocks(['  a', '- b', '- c', '+ x', '  d']);
    const { lines } = assignLineNumbers(blocks, 10);
    expect(lines.map(l => [l.kind, 'side' in l ? l.side : null, l.lineNo])).toEqual([
      ['context', null, 10],
      ['paired', 'removed', 11], // old line 11, paired with the lone addition
      ['plain', 'removed', 12], // old line 12, no counterpart
      ['paired', 'added', 11], // new line 11
      ['context', null, 12], // new line 12 (old line 13)
    ]);
  });

  it('defaults to line 1 when no startLine is given', () => {
    const blocks = parseDiffBlocks(['+ a', '+ b']);
    const { lines } = assignLineNumbers(blocks, undefined);
    expect(lines.map(l => l.lineNo)).toEqual([1, 2]);
  });

  // A bash command's second hunk starts at different lines in the old and new file once the first
  // hunk added or removed lines; removed rows must number by the old file, the rest by the new.
  it('numbers removed lines from oldStartLine when the two files drifted apart', () => {
    const blocks = parseDiffBlocks(['  a', '- b', '+ B', '  c']);
    const { lines } = assignLineNumbers(blocks, 17, 15);
    expect(lines.map(l => [l.kind, 'side' in l ? l.side : null, l.lineNo])).toEqual([
      ['context', null, 17],
      ['paired', 'removed', 16],
      ['paired', 'added', 18],
      ['context', null, 19],
    ]);
  });
});

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    const diff = '  context\n- old\n+ new1\n+ new2\n  context';
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it('handles all-added diffs (write tool)', () => {
    const diff = '+ a\n+ b\n+ c';
    expect(diffStats(diff)).toEqual({ added: 3, removed: 0 });
  });

  it('handles empty diff', () => {
    expect(diffStats('')).toEqual({ added: 0, removed: 0 });
  });
});
