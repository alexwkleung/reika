import { memo } from 'react';
import { assignLineNumbers, parseDiffBlocks } from '../../ui/diffrows.js';
import './diff.css';

// An edit's or a hunk's `+ `/`- `/`  ` lines, numbered by the TUI's rules (ui/diffrows.ts): a
// removed line takes the old file's number, an added or context line the new file's. No gutter
// without a start line, as in the TUI.
export const DiffView = memo(function DiffView({
  diff,
  startLine,
  oldStartLine,
}: {
  diff: string;
  startLine?: number;
  oldStartLine?: number;
}) {
  const { lines } = assignLineNumbers(parseDiffBlocks(diff.split('\n')), startLine, oldStartLine);
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
              <span className="diff-text">{row.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
