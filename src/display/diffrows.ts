// A diff's `+ `/`- `/`  ` lines grouped into change blocks and numbered as an editor would number
// the file. Ink-free so the browser client (src/web/client/DiffView.tsx) numbers rows the same way.

export type DiffBlock =
  | { kind: 'context'; line: string }
  | { kind: 'change'; removed: string[]; added: string[] };

// Group consecutive `-` and `+` lines into change blocks; everything else is context.
// Exported for unit tests.
export function parseDiffBlocks(lines: string[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('- ') || lines[i].startsWith('+ ')) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        removed.push(lines[i].slice(2));
        i++;
      }
      while (i < lines.length && lines[i].startsWith('+ ')) {
        added.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: 'change', removed, added });
    } else {
      blocks.push({ kind: 'context', line: lines[i] });
      i++;
    }
  }
  return blocks;
}

export type RenderRow =
  | { kind: 'context'; text: string; lineNo: number }
  | { kind: 'plain'; text: string; side: 'removed' | 'added'; lineNo: number }
  | { kind: 'paired'; text: string; other: string; side: 'removed' | 'added'; lineNo: number };

// Flatten blocks into rows in display order, assigning each a file line number.
// Removed lines advance the old-file counter, added lines the new-file counter,
// context lines both — so the gutter reads like an editor would number the file.
// Exported for unit tests.
export function assignLineNumbers(
  blocks: DiffBlock[],
  startLine: number | undefined,
  oldStartLine: number = startLine ?? 1,
): { lines: RenderRow[]; maxLineNo: number } {
  const lines: RenderRow[] = [];
  let oldNo = oldStartLine;
  let newNo = startLine ?? 1;
  let maxLineNo = 0;
  const note = (n: number) => {
    if (n > maxLineNo) maxLineNo = n;
  };

  for (const block of blocks) {
    if (block.kind === 'context') {
      const text = block.line.startsWith('  ') ? block.line.slice(2) : block.line;
      lines.push({ kind: 'context', text, lineNo: newNo });
      note(newNo);
      oldNo++;
      newNo++;
      continue;
    }
    const pairedCount = Math.min(block.removed.length, block.added.length);
    // Removed lines (paired then leftover) keyed off the old-file counter.
    for (let i = 0; i < block.removed.length; i++) {
      const lineNo = oldNo + i;
      note(lineNo);
      if (i < pairedCount) {
        lines.push({
          kind: 'paired',
          text: block.removed[i],
          other: block.added[i],
          side: 'removed',
          lineNo,
        });
      } else {
        lines.push({ kind: 'plain', text: block.removed[i], side: 'removed', lineNo });
      }
    }
    // Added lines keyed off the new-file counter.
    for (let i = 0; i < block.added.length; i++) {
      const lineNo = newNo + i;
      note(lineNo);
      if (i < pairedCount) {
        lines.push({
          kind: 'paired',
          text: block.added[i],
          other: block.removed[i],
          side: 'added',
          lineNo,
        });
      } else {
        lines.push({ kind: 'plain', text: block.added[i], side: 'added', lineNo });
      }
    }
    oldNo += block.removed.length;
    newNo += block.added.length;
  }
  return { lines, maxLineNo };
}
