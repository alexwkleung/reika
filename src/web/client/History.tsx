import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionScope, WireSessionList, WireState } from '../protocol.js';
import { switchBlocked, type Send } from './Composer.js';
import { filterPlaceholder, listNote, sessionMeta, sessionTitle } from './sessionlist.js';
import './history.css';
import { tip } from './Tooltip.js';

// This project's saved sessions, opened in place as `/resume` does (one session per server, never
// a live switcher). A pane pinned beside the chat on a wide window, a drawer over it on a narrow
// one. The pane collapses from its own header; collapsed, or narrow, two buttons at the page's
// top-left show it and start a new conversation. The server decides what may open; this only disables what it would refuse.

const FILTER_DELAY_MS = 150;
const AGE_TICK_MS = 60_000;
// Matches `--history-pane-from` in history.css.
export const PANE_QUERY = '(min-width: 72rem)';
const PINNED_KEY = 'reika.history.pinned';

// The sidebar outline with a chevron saying which way the button moves it.
function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
      <path d={open ? 'M10.5 6.25 8.75 8l1.75 1.75' : 'M9 6.25 10.75 8 9 9.75'} />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function readPinned(): boolean {
  try {
    return window.localStorage?.getItem(PINNED_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writePinned(pinned: boolean): void {
  try {
    window.localStorage?.setItem(PINNED_KEY, String(pinned));
  } catch {}
}

function mediaQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(PANE_QUERY) : null;
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => mediaQuery()?.matches ?? false);
  useEffect(() => {
    const query = mediaQuery();
    if (!query) return;
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export function History({
  session,
  waiting,
  locked,
  send,
}: {
  session: WireState | null;
  waiting: boolean;
  locked: boolean;
  send: Send;
}) {
  const wide = useWide();
  const [pinned, setPinned] = useState(readPinned);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scope, setScope] = useState<SessionScope>('project');
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<WireSessionList | null>(null);
  // A refused open, kept until the next action; and a failed listing, cleared by the next good one.
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Bumped to ask again after a refusal that says the list is out of date.
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(Date.now);
  const showButton = useRef<HTMLButtonElement>(null);
  // Focus goes back to the show button once it is on screen again.
  const focusShowButton = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const requestSeq = useRef(0);
  // Focus moves into the panel only when the user opened it, never for a pane shown on load.
  const focusOnShow = useRef(false);

  const asPane = wide && pinned;
  const shown = asPane || (!wide && drawerOpen);
  const blocked = locked ? 'Reload the page first' : switchBlocked(session, waiting);
  const current = session?.session ?? null;
  // A turn ending is when auto-save has just moved titles and counts.
  const idle = session?.status === 'idle';
  // A pane is on screen from the first paint, before the page has signed in.
  const ready = session !== null;

  useEffect(() => {
    const t = setTimeout(() => setQuery(filter), FILTER_DELAY_MS);
    return () => clearTimeout(t);
  }, [filter]);

  useEffect(() => {
    if (!shown || !ready) return;
    const seq = ++requestSeq.current;
    void send({ type: 'sessions', scope, ...(query.trim() ? { filter: query } : {}) }).then(r => {
      if (seq !== requestSeq.current) return;
      if (r.kind === 'ok' && r.reply && 'scope' in r.reply) {
        setList(r.reply);
        setListError(null);
        setNow(Date.now());
        return;
      }
      setListError(
        r.kind === 'signed-out' ? 'Signed out: open a fresh link.' : 'Could not list sessions.',
      );
    });
  }, [shown, ready, scope, query, current, idle, reload, send]);

  useEffect(() => {
    if (!shown) return;
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(t);
  }, [shown]);

  useEffect(() => {
    // The button that hides it again, where the show button was: typing in the filter is a choice
    // the user makes, not where opening the panel should leave them.
    if (shown && focusOnShow.current) closeButton.current?.focus();
    if (!shown && focusShowButton.current) showButton.current?.focus();
    focusOnShow.current = false;
    focusShowButton.current = false;
  }, [shown]);

  // The pane takes its width from the page; the drawer holds the page still under it.
  useEffect(() => {
    if (asPane) {
      document.body.classList.add('with-history');
      return () => document.body.classList.remove('with-history');
    }
    if (!drawerOpen || wide) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [asPane, drawerOpen, wide]);

  // The filter goes with the panel: a list reopened under an old filter reads as sessions gone
  // missing.
  const hide = () => {
    setError(null);
    setFilter('');
    setQuery('');
    if (wide) {
      setPinned(false);
      writePinned(false);
    } else {
      setDrawerOpen(false);
    }
    focusShowButton.current = true;
  };
  const show = () => {
    focusOnShow.current = true;
    if (wide) {
      setPinned(true);
      writePinned(true);
    } else {
      setDrawerOpen(true);
    }
  };

  // A resume lands in a frame or two, and dimming every row for it read as a flicker: while one is
  // in flight the rows look the same and ignore clicks (aria-disabled), and only a block the user
  // must wait out (a running prompt) dims them.
  const act = async (id: string, message: Parameters<Send>[0]) => {
    if (pending !== null) return;
    setPending(id);
    setError(null);
    const r = await send(message);
    setPending(null);
    if (r.kind === 'ok') {
      // A pane stays where it is; the drawer gets out of the way of the conversation it opened.
      if (!asPane) hide();
      return;
    }
    refused(r);
  };
  const refused = (r: Exclude<Awaited<ReturnType<Send>>, { kind: 'ok' }>) => {
    if (r.kind === 'conflict') {
      setError(r.error.replace(/^./, c => c.toUpperCase()) + '.');
      setReload(n => n + 1);
      return;
    }
    setError(r.kind === 'signed-out' ? 'Signed out: open a fresh link.' : r.error);
  };
  // From the collapsed rail: nothing to close on success, and a refusal opens the panel, the one
  // place an error is drawn.
  const startNew = async () => {
    if (pending !== null) return;
    setPending('new');
    setError(null);
    const r = await send({ type: 'new' });
    setPending(null);
    if (r.kind === 'ok') return;
    refused(r);
    show();
  };

  // The drawer is modal: Escape closes it and Tab stays inside. The pane is part of the page.
  const onKeyDown = (e: KeyboardEvent) => {
    if (asPane) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const focusable = [
      ...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input'),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const note = list ? listNote(list, query) : null;
  const body = (
    <aside
      ref={panel}
      id="history-panel"
      className={asPane ? 'history history--pane' : 'history history--drawer'}
      aria-label="History"
      {...(asPane ? {} : { role: 'dialog', 'aria-modal': true })}
      onKeyDown={onKeyDown}
    >
      <div className="history-head">
        <button
          type="button"
          className="history-new"
          disabled={blocked !== null}
          aria-disabled={pending !== null || undefined}
          {...tip(blocked)}
          onClick={() => void act('new', { type: 'new' })}
        >
          <PlusIcon />
          New conversation
        </button>
        {asPane ? (
          <button
            ref={closeButton}
            type="button"
            className="history-close"
            aria-label="Hide history"
            {...tip('Hide history', { aria: false })}
            aria-expanded="true"
            aria-controls="history-panel"
            onClick={hide}
          >
            <PanelIcon open />
          </button>
        ) : (
          <button
            ref={closeButton}
            type="button"
            className="history-close"
            aria-label="Close"
            onClick={hide}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
      <div className="history-search">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.25" />
          <path d="M10.25 10.25L13.5 13.5" />
        </svg>
        <input
          className="history-filter"
          type="search"
          placeholder={filterPlaceholder(list)}
          aria-label="Filter sessions by title"
          value={filter}
          maxLength={200}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      {error || listError ? (
        <p className="history-error" role="alert">
          {error ?? listError}
        </p>
      ) : null}
      <ul className="history-list" aria-label="Sessions" aria-busy={list === null}>
        {list?.entries.map(entry => {
          const isCurrent = entry.current === true;
          const reason = isCurrent ? 'The session you are in' : blocked;
          return (
            <li key={entry.id}>
              <button
                type="button"
                className="history-row"
                aria-current={isCurrent ? 'true' : undefined}
                disabled={reason !== null}
                aria-disabled={pending !== null || undefined}
                // A title cut to the row's one line is still there to read. Why a row is off goes
                // unsaid here: the current one is marked, and a running prompt is in the input box.
                {...tip(sessionTitle(entry), { cut: '.history-title-text' })}
                onClick={() => void act(entry.id, { type: 'resume', scope, id: entry.id })}
              >
                <span className="history-title">
                  <span className="history-title-text">{sessionTitle(entry)}</span>
                  {entry.chat ? <span className="history-tag">chat</span> : null}
                  {isCurrent ? <span className="history-tag">current</span> : null}
                </span>
                {/* No "Opening…" in its place: a resume lands in a moment, and the swap read as a
                    flicker. The disabled rows already say something is under way. */}
                <span className="history-meta">{sessionMeta(entry, now)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {note ? <p className="history-note">{note}</p> : null}
      <label className="history-scope">
        <input
          type="checkbox"
          role="switch"
          checked={scope === 'root'}
          onChange={e => {
            setList(null);
            setScope(e.target.checked ? 'root' : 'project');
          }}
        />
        <span className="history-switch" aria-hidden="true" />
        Show /save transcripts
      </label>
    </aside>
  );

  return (
    <>
      {asPane ? null : (
        <div className="history-rail">
          <button
            ref={showButton}
            type="button"
            className="history-show"
            aria-label="Show history"
            {...tip('Show history', { aria: false })}
            aria-expanded={shown}
            onClick={show}
          >
            <PanelIcon open={false} />
          </button>
          <button
            type="button"
            className="history-show history-rail-new"
            aria-label="New conversation"
            {...tip(blocked ?? 'New conversation', { aria: blocked !== null })}
            disabled={blocked !== null}
            aria-disabled={pending !== null || undefined}
            onClick={() => void startNew()}
          >
            <PlusIcon />
          </button>
        </div>
      )}
      {asPane ? body : null}
      {shown && !asPane ? (
        <div className="history-layer">
          <div className="history-backdrop" onClick={hide} aria-hidden="true" />
          {body}
        </div>
      ) : null}
    </>
  );
}
