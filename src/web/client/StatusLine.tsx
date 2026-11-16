import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WireState } from '../protocol.js';
import type { StreamStatus } from './eventstream.js';
import { nextPathLine, PATH_INLINE, pathFits, pathReturnsAt } from './pathdwell.js';
import { CWD_MAX_CHARS, shortenMiddle, statusStrip } from './statuschips.js';
import './status.css';
import { tip } from './Tooltip.js';

// The quiet strip under the input box: approvals, the context meter, the session's numbers and the
// folder, with a session error above it.
export function StatusLine({
  session,
  stream,
}: {
  session: WireState | null;
  stream: StreamStatus | null;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const pathRef = useRef<HTMLSpanElement>(null);
  const line = useRef(PATH_INLINE);
  const [own, setOwn] = useState(false);
  const [recheck, setRecheck] = useState(0);
  // After every render and before paint, so a path that stops fitting never draws a frame wrapped
  // by flex alone; the hold then keeps it there.
  useBeforePaint(() => {
    const fits = measurePathFits(stripRef.current, groupRef.current, pathRef.current);
    if (fits === null) return;
    line.current = nextPathLine(line.current, fits, Date.now());
    setOwn(line.current.own);
  }, [session, stream, recheck]);
  // A held path comes back once its dwell is over, even if nothing else renders by then.
  const returnsAt = pathReturnsAt(line.current);
  useEffect(() => {
    if (returnsAt === null) return;
    const t = setTimeout(() => setRecheck(n => n + 1), Math.max(0, returnsAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [returnsAt, recheck]);
  // The window narrowing or widening changes the room without a render.
  const mounted = session !== null;
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setRecheck(n => n + 1));
    observer.observe(strip);
    return () => observer.disconnect();
  }, [mounted]);
  if (!session) return null;
  const items = statusStrip(session, stream);
  // The folder sits outside the group: `space-between` keeps it at the right on the group's line,
  // and once it wraps onto a line of its own it is that line's only item, so it starts at the left.
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
      case 'path': {
        const shown = shortenMiddle(item.text, CWD_MAX_CHARS);
        // The whole folder, when either the shortening or the strip's width cut it.
        return (
          <span
            key={i}
            ref={pathRef}
            className={`status-path${own ? ' status-path--own' : ''}`}
            {...(shown === item.text ? tip(item.text, { cut: '' }) : tip(item.text))}
          >
            {shown}
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
      <div ref={stripRef} className="status-strip" aria-label="Status">
        <span ref={groupRef} className="status-items">
          {items.filter(item => item.kind !== 'path').map(renderItem)}
        </span>
        {items.filter(item => item.kind === 'path').map(renderItem)}
      </div>
    </div>
  );
}

// The layout effect where there is a page to paint; a server render (a test) has none and warns.
const useBeforePaint = typeof document === 'undefined' ? useEffect : useLayoutEffect;

// Null where nothing can be measured (no path, or a DOM without layout, as in render tests).
function measurePathFits(
  strip: HTMLElement | null,
  group: HTMLElement | null,
  path: HTMLElement | null,
): boolean | null {
  if (!strip || !group || !path || typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  range.selectNodeContents(path);
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const pathWidth = range.getBoundingClientRect().width;
  const stripStyle = getComputedStyle(strip);
  const chipGap = parseFloat(getComputedStyle(group).columnGap) || 0;
  const chips = [...group.children].map(c => c.getBoundingClientRect().width);
  const chipsWidth = chips.reduce((sum, w) => sum + w, 0) + chipGap * Math.max(0, chips.length - 1);
  return pathFits(strip.clientWidth, chipsWidth, pathWidth, parseFloat(stripStyle.columnGap) || 0);
}
