import type { WireState } from '../protocol.js';
import type { StreamStatus } from './eventstream.js';
import { CWD_MAX_CHARS, shortenMiddle, statusStrip } from './statuschips.js';
import './status.css';

// The quiet strip under the input box: approvals, the context meter, the session's numbers and the
// folder, with a session error above it.
export function StatusLine({
  session,
  stream,
}: {
  session: WireState | null;
  stream: StreamStatus | null;
}) {
  if (!session) return null;
  return (
    <div className="status">
      {session.error ? (
        <div className="status-error" role="alert">
          {session.error}
        </div>
      ) : null}
      <div className="status-strip" aria-label="Status">
        {statusStrip(session, stream).map((item, i) => {
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
                  title={item.title}
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
                <span key={i} className="status-stat" title={item.title}>
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
              const label = `PR #${item.number}`;
              return (
                <span key={i} className="status-pr">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" title={item.url}>
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                  {item.state ? (
                    <span className={`status-pr-state status-pr-state--${item.state}`}>
                      {` ${item.state}`}
                    </span>
                  ) : null}
                </span>
              );
            }
            case 'path':
              return (
                <span key={i} className="status-path" title={item.text}>
                  {shortenMiddle(item.text, CWD_MAX_CHARS)}
                </span>
              );
          }
        })}
      </div>
    </div>
  );
}
