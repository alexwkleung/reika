import { diffArrays } from 'diff';

const CONTEXT_LINES = 3;

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
  if (countCommon(oldLines, newLines) === 0) {
    // No line survives on both sides: the whole old block is removed and the
    // whole new block added. diffArrays (Myers) costs O(n*m) to reach that
    // same conclusion; emit it directly.
    for (const l of oldLines) out.push(`- ${l}`);
    for (const l of newLines) out.push(`+ ${l}`);
  } else {
    for (const change of diffArrays(oldLines, newLines)) {
      const prefix = change.removed ? '- ' : change.added ? '+ ' : '  ';
      for (const l of change.value) out.push(`${prefix}${l}`);
    }
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

// Count lines that appear in both sides, respecting multiplicity: a line that
// occurs twice on one side and once on the other counts as one common line.
// 0 means no line survives on both sides, so the diff is a full rewrite.
function countCommon(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = counts.get(l);
    if (c !== undefined && c > 0) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return common;
}
