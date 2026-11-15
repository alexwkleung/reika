import type { WireState } from '../protocol.js';
import type { StreamStatus } from './eventstream.js';
import { statusLineChips } from './statuschips.js';
import './status.css';

// One muted line under the input box. Functional, not designed.
export function StatusLine({
  session,
  turns,
  stream,
}: {
  session: WireState | null;
  turns: number;
  stream: StreamStatus | null;
}) {
  if (!session) return null;
  const chips = statusLineChips(session, turns, stream);
  return (
    <div className="status">
      {session.error ? (
        <div className="status-error" role="alert">
          {session.error}
        </div>
      ) : null}
      <div className="status-line" aria-label="Status">
        {chips.map((c, i) => (
          <span key={i} className={`status-chip status-chip--${c.tone}`} title={c.text}>
            {c.text}
          </span>
        ))}
      </div>
    </div>
  );
}
