import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { PROTOCOL_VERSION } from '../protocol.js';
import { runningCommand } from './livecommand.js';
import { Composer, type Send, type Upload } from './Composer.js';
import { connectionNotice, type Connection } from './connection.js';
import { Dialogs } from './Dialogs.js';
import { isScrollUpWheel, nextFollow, type FollowEvent } from './follow.js';
import { frameBatched, type FrameScheduler } from './framebatch.js';
import { History } from './History.js';
import type { Holder } from './holder.js';
import { BusyLine, busyLabel, LiveTurn } from './LiveTurn.js';
import { StatusLine } from './StatusLine.js';
import type { ClientState } from './store.js';
import { Transcript } from './Transcript.js';
import { TooltipLayer } from './Tooltip.js';

// The page: the history drawer, the connection banner, the transcript, the running turn under its last row, and the
// controls pinned under it: the first open dialog, the input box and the status line.

function useFramed<T>(holder: Holder<T>, schedule: FrameScheduler): T {
  const subscribe = useCallback(
    (listener: () => void) => holder.subscribe(frameBatched(listener, schedule)),
    [holder, schedule],
  );
  return useSyncExternalStore(subscribe, holder.get, holder.get);
}

// Follows the bottom while the reader is there (follow.ts decides). The transcript scrolls inside
// its own element, so that is what is measured and moved.
function useFollowBottom(
  content: unknown,
  replaced: number,
  scroller: RefObject<HTMLElement | null>,
): { following: boolean; jump: () => void } {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // Where the last scroll left the view, ours included: a scroll event compares against it to
  // tell the reader's move up from a row arriving.
  const lastTop = useRef(0);
  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [scroller]);
  const apply = useCallback(
    (event: FollowEvent) => {
      const next = nextFollow(followingRef.current, event);
      followingRef.current = next;
      setFollowing(next);
      if (next) toBottom();
    },
    [toBottom],
  );
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    const settle = (next: boolean) => {
      if (next !== followingRef.current) {
        followingRef.current = next;
        setFollowing(next);
      }
    };
    const onScroll = () => {
      settle(
        nextFollow(followingRef.current, {
          type: 'user-scroll',
          metrics: {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          },
          previousTop: lastTop.current,
        }),
      );
      lastTop.current = el.scrollTop;
    };
    // A wheel turned up lets go before its scroll lands: a row arriving in between would otherwise
    // be followed, putting the view back at the bottom under the reader's wheel.
    const onWheel = (e: WheelEvent) => {
      if (!isScrollUpWheel(e, el.scrollTop)) return;
      settle(nextFollow(followingRef.current, { type: 'scroll-up-intent' }));
    };
    // A narrower window rewraps the rows, and taller controls shorten the transcript. The column is
    // watched too: some rows grow it with no new state behind them (the pending `↳ Running…` row
    // after its delay, a Thinking block opening), which the content effect below never sees.
    // Content that shrinks to fit the view leaves nothing below it, so the reader is at the bottom
    // again whatever they scrolled before.
    const onResize = () => {
      if (followingRef.current) toBottom();
      else if (el.scrollHeight <= el.clientHeight + 1) settle(true);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    observer?.observe(el);
    for (const child of el.children) observer?.observe(child);
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [scroller, toBottom]);
  useEffect(() => {
    if (followingRef.current) apply({ type: 'content-grew' });
  }, [content, apply]);
  // Another conversation opened: start at its end, as the terminal does, wherever the reader had
  // scrolled the last one. Following again also holds the end while its rows are still drawing.
  // Before paint, so its first frame is not drawn at the old conversation's scroll position.
  useLayoutEffect(() => {
    if (replaced > 0) apply({ type: 'jump' });
  }, [replaced, apply]);
  return { following, jump: () => apply({ type: 'jump' }) };
}

export function App({
  state,
  connection,
  schedule,
  send,
  upload,
}: {
  state: Holder<ClientState>;
  connection: Holder<Connection>;
  schedule: FrameScheduler;
  send: Send;
  upload?: Upload;
}) {
  const s = useFramed(state, schedule);
  const c = useFramed(connection, schedule);
  const notice = connectionNotice(c);
  const version =
    s.versionMismatch !== null
      ? `The server speaks protocol ${s.versionMismatch} and this page ${PROTOCOL_VERSION}: reload, or update reika.`
      : null;
  const busy = s.session?.status === 'busy';
  const mode = s.session?.mode;
  const scroller = useRef<HTMLElement>(null);
  const { following, jump } = useFollowBottom(s, s.replaced, scroller);
  const restoreLine = useRef<() => void>(() => {});
  return (
    <div className="app">
      <TooltipLayer />
      <History
        session={s.session}
        waiting={s.dialogs.length > 0}
        locked={s.versionMismatch !== null}
        send={send}
      />
      {notice || version ? (
        <div className="app-banner" role="status">
          <div className="app-column">
            <span className="app-banner-marker" aria-hidden="true">
              ⟳
            </span>
            {[notice, version].filter(Boolean).join(' ')}
          </div>
        </div>
      ) : null}
      <main
        ref={scroller}
        className={`app-scroll${following ? ' app-scroll--following' : ''}`}
        aria-label="Transcript"
      >
        <div className="app-column app-main">
          <Transcript messages={s.messages} idle={!busy} />
          {s.live ? (
            <LiveTurn
              live={s.live}
              busy={busy}
              planShown={mode === 'agent' || mode === 'vibe'}
              clockOffset={s.clockOffset}
              command={s.live.pending?.name === 'bash' ? runningCommand(s.messages) : null}
            />
          ) : null}
        </div>
      </main>
      <div className="app-controls">
        <div className="app-column">
          {/* In the controls, so it sits centred over the input box rather than at the window edge. */}
          {following ? null : (
            <button type="button" className="app-jump" onClick={jump}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
              </svg>
              Jump to latest
            </button>
          )}
          {/* Pinned above the input as the TUI's is, so it never scrolls under it; hidden while a
              dialog is up, as the TUI hides it behind an approval or a question. */}
          {busy && s.live && s.dialogs.length === 0 ? (
            <BusyLine {...busyLabel(s.live)} words={s.session?.workingWords ?? false} />
          ) : null}
          <Dialogs dialogs={s.dialogs} send={send} onDontSend={() => restoreLine.current()} />
          <Composer
            send={send}
            upload={upload}
            session={s.session}
            catalog={s.catalog}
            history={s.history}
            waiting={s.dialogs.length > 0}
            locked={s.versionMismatch !== null}
            restoreLine={restoreLine}
          />
          <StatusLine session={s.session} stream={c.stream} />
        </div>
      </div>
    </div>
  );
}
