import { memo, type ReactNode } from 'react';
import { assignLineNumbers, parseDiffBlocks, type RenderRow } from '../../display/diffrows.js';
import { detectLanguage, intraLineParts } from '../../display/intraline.js';
import { highlightNodes, sliceNodes, toReact } from './highlight.js';
import './diff.css';

// An edit's or a hunk's `+ `/`- `/`  ` lines, numbered by the TUI's rules (display/diffrows.ts): a
// removed line takes the old file's number, an added or context line the new file's. No gutter
// without a start line, as in the TUI. Every row is syntax-coloured from the path, and a paired
// line marks its changed words when the TUI would (display/intraline.ts).

function rowContent(row: RenderRow, language: string): ReactNode[] {
  const nodes = highlightNodes(row.text, language);
  if (row.kind !== 'paired') return toReact(nodes);
  const [oldText, newText] = row.side === 'removed' ? [row.text, row.other] : [row.other, row.text];
  const parts = intraLineParts(oldText, newText);
  if (!parts) return toReact(nodes);
  const out: ReactNode[] = [];
  let offset = 0;
  parts.forEach((p, i) => {
    // A segment that exists only on the other side draws nothing here.
    if ((row.side === 'removed' && p.added) || (row.side === 'added' && p.removed)) return;
    const start = offset;
    offset += p.value.length;
    const changed = row.side === 'removed' ? p.removed : p.added;
    // The changed words take one colour on a brighter tint, as in the TUI, so they read on it.
    out.push(
      changed ? (
        <span key={i} className="diff-word">
          {p.value}
        </span>
      ) : (
        <span key={i}>{toReact(sliceNodes(nodes, start, offset), `${i}.`)}</span>
      ),
    );
  });
  return out;
}

export const DiffView = memo(function DiffView({
  diff,
  path,
  startLine,
  oldStartLine,
}: {
  diff: string;
  path: string;
  startLine?: number;
  oldStartLine?: number;
}) {
  const { lines } = assignLineNumbers(parseDiffBlocks(diff.split('\n')), startLine, oldStartLine);
  const language = detectLanguage(path);
  const gutter = startLine !== undefined;
  return (
    <div className="diff" role="group" aria-label="diff">
      <div className="diff-rows">
        {lines.map((row, i) => {
          const side = row.kind === 'context' ? 'context' : row.side;
          const marker = side === 'added' ? '+' : side === 'removed' ? '-' : ' ';
          return (
            <div key={i} className={`diff-row diff-row--${side}`}>
              {gutter ? <span className="diff-lineno">{row.lineNo}</span> : null}
              <span className="diff-marker" aria-hidden={side === 'context'}>
                {marker}
              </span>
              <span className="diff-text">{rowContent(row, language)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
