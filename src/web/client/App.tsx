import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION } from '../protocol.js';
import { Composer, type Send } from './Composer.js';
import { connectionNotice, type Connection } from './connection.js';
import { Dialogs } from './Dialogs.js';
import { nextFollow, type FollowEvent } from './follow.js';
import { frameBatched, type FrameScheduler } from './framebatch.js';
import type { Holder } from './holder.js';
import { LiveTurn } from './LiveTurn.js';
import { StatusLine } from './StatusLine.js';
import type { ClientState } from './store.js';
import { Transcript } from './Transcript.js';

// The page: the connection banner, the transcript, the running turn under its last row, and the
// controls pinned under it: the first open dialog, the input box and the status line.

function useFramed<T>(holder: Holder<T>, schedule: FrameScheduler): T {
  const subscribe = useCallback(
    (listener: () => void) => holder.subscribe(frameBatched(listener, schedule)),
    [holder, schedule],
  );
  return useSyncExternalStore(subscribe, holder.get, holder.get);
}

function metrics() {
  const el = document.scrollingElement ?? document.documentElement;
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}

// Follows the bottom while the reader is there (follow.ts decides); off the page it does nothing.
function useFollowBottom(content: unknown): { following: boolean; jump: () => void } {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const apply = useCallback((event: FollowEvent) => {
    const next = nextFollow(followingRef.current, event);
    followingRef.current = next;
    setFollowing(next);
    if (next) window.scrollTo({ top: metrics().scrollHeight });
  }, []);
  useEffect(() => {
    const onScroll = () => {
      const next = nextFollow(followingRef.current, { type: 'user-scroll', metrics: metrics() });
      if (next !== followingRef.current) {
        followingRef.current = next;
        setFollowing(next);
      }
    };
    // A narrower window rewraps the rows and taller controls cover the last one.
    const onResize = () => {
      if (followingRef.current) window.scrollTo({ top: metrics().scrollHeight });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  useEffect(() => {
    if (followingRef.current) apply({ type: 'content-grew' });
  }, [content, apply]);
  return { following, jump: () => apply({ type: 'jump' }) };
}

export function App({
  state,
  connection,
  schedule,
  send,
}: {
  state: Holder<ClientState>;
  connection: Holder<Connection>;
  schedule: FrameScheduler;
  send: Send;
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
  const { following, jump } = useFollowBottom(s);
  // The TUI's `turn N`: every assistant message so far.
  const turns = useMemo(() => s.messages.filter(m => m.role === 'assistant').length, [s.messages]);
  return (
    <div className="app">
      {notice || version ? (
        <div className="app-banner" role="status">
          <span className="app-banner-marker" aria-hidden="true">
            ⟳
          </span>
          {[notice, version].filter(Boolean).join(' ')}
        </div>
      ) : null}
      <main className="app-main" aria-label="Transcript">
        <Transcript messages={s.messages} idle={!busy} />
        {s.live ? (
          <LiveTurn
            live={s.live}
            busy={busy}
            planShown={mode === 'agent' || mode === 'vibe'}
            clockOffset={s.clockOffset}
          />
        ) : null}
      </main>
      <div className="app-controls">
        <Dialogs dialogs={s.dialogs} send={send} />
        <Composer
          send={send}
          session={s.session}
          catalog={s.catalog}
          history={s.history}
          waiting={s.dialogs.length > 0}
          locked={s.versionMismatch !== null}
        />
        <StatusLine session={s.session} turns={turns} stream={c.stream} />
      </div>
      {following ? null : (
        <button type="button" className="app-jump" onClick={jump}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
