import { diffArrays } from 'diff';

const CONTEXT_LINES = 3;

// Myers (what jsdiff runs) costs O(D²) in the edit distance, not in the file: a diff that shares
// little between its sides is the expensive one, whatever its size. A wholesale rewrite measured
// 120ms at 1k lines, 2.9s at 5k and 17s at 12k (M2; #244), synchronously on the TUI thread — and
// the result is a diff nobody reads, since every row is a `-` or a `+` and DiffView shows 80 of
// them. So the search stops here (≈55ms at the cap) and the caller draws the change the way the
// finished diff would have looked anyway: everything removed, everything added. Below the cap
// the output is byte-identical to the uncapped one; jsdiff only ever returns undefined past it.
export const MAX_EDIT_LENGTH = 1000;

export function buildEditDiff(
  oldString: string,
  newString: string,
  beforeText: string,
  afterText: string,
): string {
  const before = lastLines(beforeText, CONTEXT_LINES);
  const after = firstLines(afterText, CONTEXT_LINES);
  const oldLines = stripTrailingNewline(oldString).split('\n');
  const newLines = stripTrailingNewline(newString).split('\n');

  const out: string[] = [];
  for (const l of before) out.push(`  ${l}`);
  // Line-level diff so lines that exist on both sides render as context (`  `)
  // rather than being naively dumped as `-` then `+`. Reveals what actually
  // changed instead of repeating the whole block twice.
  const changes = diffArrays(oldLines, newLines, { maxEditLength: MAX_EDIT_LENGTH }) ?? [
    { removed: true, added: false, value: oldLines, count: oldLines.length },
    { removed: false, added: true, value: newLines, count: newLines.length },
  ];
  for (const change of changes) {
    const prefix = change.removed ? '- ' : change.added ? '+ ' : '  ';
    for (const l of change.value) out.push(`${prefix}${l}`);
  }
  for (const l of after) out.push(`  ${l}`);
  return out.join('\n');
}

// 1-based file line number of the first line the edit diff renders. The diff
// leads with up to CONTEXT_LINES of `beforeText`'s trailing lines, so the first
// shown line sits that many lines above where the match begins.
export function editDiffStartLine(beforeText: string): number {
  const matchStartLine = beforeText === '' ? 1 : beforeText.split('\n').length;
  const beforeCount = lastLines(beforeText, CONTEXT_LINES).length;
  return Math.max(1, matchStartLine - beforeCount);
}

export function buildWriteDiff(content: string): string {
  const lines = stripTrailingNewline(content).split('\n');
  return lines.map(l => `+ ${l}`).join('\n');
}

function lastLines(text: string, n: number): string[] {
  if (!text) return [];
  const lines = stripTrailingNewline(text).split('\n');
  return lines.slice(-n);
}

function firstLines(text: string, n: number): string[] {
  if (!text) return [];
  const lines = stripLeadingNewline(text).split('\n');
  return lines.slice(0, n);
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function stripLeadingNewline(s: string): string {
  return s.startsWith('\n') ? s.slice(1) : s;
}
