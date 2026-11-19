import type { WireState } from '../protocol.js';
import type { StreamStatus } from './eventstream.js';
import { statusStrip } from './statuschips.js';
import './status.css';
import { tip } from './Tooltip.js';

// The quiet strip under the input box: approvals, the context meter, the session's numbers and the
// branch's PR, with a session error above it. The folder is in the input box's row (ProjectPath).
export function StatusLine({
  session,
  stream,
}: {
  session: WireState | null;
  stream: StreamStatus | null;
}) {
  if (!session) return null;
  const items = statusStrip(session, stream);
  const renderItem = (item: (typeof items)[number], i: number) => {
    switch (item.kind) {
      case 'tag':
        return (
          <span key={i} className={`status-tag status-tag--${item.tone}`}>
            {item.text}
          </span>
        );
      case 'meter':
        return (
          <span
            key={i}
            className={`status-meter${item.warn ? ' status-meter--warn' : ''}`}
            {...tip(item.title)}
          >
            {item.fill !== null ? (
              <span
                className="status-track"
                role="meter"
                aria-label="Context used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.fill * 100)}
              >
                <span className="status-fill" style={{ width: `${item.fill * 100}%` }} />
              </span>
            ) : null}
            {item.text}
          </span>
        );
      case 'stat':
        return (
          <span key={i} className="status-stat" {...tip(item.title)}>
            {item.text}
          </span>
        );
      case 'alert':
        return (
          <span key={i} className="status-alert" role="status">
            {item.text}
          </span>
        );
      case 'pr': {
        // The number is the link and the `PR ` label is not, as the TUI's chip draws it.
        const number = `#${item.number}`;
        return (
          <span key={i} className="status-pr">
            {'PR '}
            {item.url ? (
              // No tip: the browser shows a link's address on hover itself.
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {number}
              </a>
            ) : (
              number
            )}
            {item.state ? (
              <span className={`status-pr-state status-pr-state--${item.state}`}>
                {` ${item.state}`}
              </span>
            ) : null}
          </span>
        );
      }
    }
  };
  return (
    <div className="status">
      {session.error ? (
        <div className="status-error" role="alert">
          {session.error}
        </div>
      ) : null}
      <div className="status-strip" aria-label="Status">
        <span className="status-items">{items.map(renderItem)}</span>
      </div>
    </div>
  );
}
