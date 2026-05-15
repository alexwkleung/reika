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
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  for (const l of after) out.push(`  ${l}`);
  return out.join('\n');
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
