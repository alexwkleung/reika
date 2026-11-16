import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import {
  MAX_SUBMIT_IMAGES,
  WIRE_MODES,
  type ClientMessage,
  type WireCatalog,
  type WireState,
} from '../protocol.js';
import { isLargePaste, type PastedText } from '../../ui/pastes.js';
import { isTypingEdge } from './typingedge.js';
import type { Mode } from '../../types.js';
import {
  acceptCompletion,
  completionRequestText,
  splitDisplay,
  wantsCompletion,
  type Completion,
} from './completion.js';
import { afterSend, parkPaste, pastesFor } from './composerpastes.js';
import {
  chipLabel,
  imageRefusal,
  imagesFor,
  nextImageMarker,
  stillReading,
  withoutMarker,
  type ImageChip,
} from './composerimages.js';
import { connectionNotice } from './connection.js';
import { notRecalling, recallStep, type Recall } from './inputhistory.js';
import { caretLines, carriesImage, composerKeyAction, IMAGES_UNSUPPORTED } from './keys.js';
import { ImagePreview } from './ImagePreview.js';
import { PillMenu, type PillOption } from './PillMenu.js';
import type { SendResult, UploadResult } from './send.js';
import './composer.css';
import { tip } from './Tooltip.js';

// The input box (direction B): the text, then a row inside the box with the mode and model pills,
// attach, and Send (Stop while a turn runs from an empty box). Enter sends, Shift+Enter or a
// trailing `\` breaks the line, ↑/↓ at the box's edges walk the shared history, and `/` or `@`
// opens the server's completion list. A prompt sent while a turn runs is queued by the server.

export type Send = (message: ClientMessage) => Promise<SendResult>;
export type Upload = (file: Blob) => Promise<UploadResult>;

// The line under the box for a send that did not land.
export function sendFailure(result: SendResult): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'signed-out':
      return connectionNotice({ signIn: { kind: 'signed-in', token: '' }, stream: 'signed-out' });
    case 'conflict':
      return result.error;
    case 'failed':
      return result.status === null ? `Cannot reach the server: ${result.error}` : result.error;
  }
}

// The TUI's placeholder, less the image hint until images work here (#979).
// `pasteKey` names the image paste on this platform, when images can be attached at all.
export function placeholderFor(
  mode: Mode,
  busy: boolean,
  locked: boolean,
  pasteKey: string | null = null,
): string {
  if (locked) return 'Reload the page to keep going';
  if (busy) return 'Queue a message · Esc stops';
  if (mode === 'shell') return 'Run a shell command';
  const images = pasteKey ? `, ${pasteKey} for images` : '';
  return `Type / for commands, @ to attach files${images}`;
}

const PASTE_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌘V'
    : 'Ctrl+V';

// Why the pills are off, or null when a switch can go through. The server decides; this only
// keeps a click that would be refused from looking like it might work.
export function switchBlocked(session: WireState | null, waiting: boolean): string | null {
  if (!session || session.status === 'loading') return 'Starting the session';
  if (session.status === 'busy' || session.preparing || session.queue.length > 0) {
    return 'Switch once the running prompt finishes';
  }
  if (waiting) return 'Answer the question above first';
  return null;
}

const modeColor = (mode: Mode) => `var(--reika-mode-${mode})`;

export function modelOptions(catalog: WireCatalog | null): PillOption[] {
  return (catalog?.models ?? []).map(t => ({
    value: t.name,
    label: t.name,
    detail: t.group ?? (t.name === t.model.toLowerCase() ? null : t.model),
    checked: t.active,
  }));
}

// Grows with its content up to the CSS max-height, then scrolls. The scrollbar only exists past
// that height: a box that fits its text shows none, even for a frame where a new placeholder or
// width has not been fitted yet.
function fitHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const full = el.scrollHeight;
  el.style.height = `${full}px`;
  el.style.overflowY = full > el.clientHeight + 1 ? 'auto' : 'hidden';
}

function selection(el: HTMLTextAreaElement): { start: number; end: number } {
  const end = el.value.length;
  return { start: el.selectionStart ?? end, end: el.selectionEnd ?? end };
}

export function Composer({
  send,
  upload,
  session,
  catalog,
  history,
  waiting,
  locked,
  restoreLine,
}: {
  send: Send;
  // Absent: images are refused with a line saying so, as before uploads existed.
  upload?: Upload;
  session: WireState | null;
  catalog: WireCatalog | null;
  history: string[];
  // A dialog is open above: it takes the answer, as the TUI intercepts typing for one.
  waiting: boolean;
  // The server speaks another protocol version: nothing here can be trusted to land.
  locked: boolean;
  // Set here, called by a confirm's "Don't send": the TUI leaves a cancelled prompt in its box.
  restoreLine?: MutableRefObject<() => void>;
}) {
  const mode = session?.mode ?? 'agent';
  const busy = session?.status === 'busy';
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parked, setParked] = useState<PastedText[]>([]);
  const [chips, setChips] = useState<ImageChip[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  // Every thumbnail URL not yet let go: revoked when its chip is gone for good, and on unmount.
  const previews = useRef(new Set<string>());
  const letGo = (gone: ImageChip[]): void => {
    for (const c of gone) {
      if (c.preview && previews.current.delete(c.preview)) URL.revokeObjectURL(c.preview);
    }
  };
  useEffect(() => {
    const live = previews.current;
    return () => {
      for (const url of live) URL.revokeObjectURL(url);
      live.clear();
    };
  }, []);
  const [recall, setRecall] = useState<Recall>(notRecalling);
  const [completion, setCompletion] = useState<{ list: Completion; selected: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const completionList = useRef<HTMLUListElement>(null);
  // Where to put the caret once a programmatic change has rendered.
  const caret = useRef<number | null>(null);
  // Only the newest completion request's answer is shown.
  const completionSeq = useRef(0);
  // A line this tab sent while nothing else ran, so the one now being prepared, until that ends.
  // Only it may come back on "Don't send": a confirm another tab's line raised is not this box's.
  // A line that finishes before its POST answers can outlive its preparation here; the cost is
  // this tab's previous line refilling an empty box, which is visible and harmless.
  // With the chips it named: a line sent back keeps its images, which the server hands back too.
  const ownLine = useRef<{ text: string; chips: ImageChip[] } | null>(null);
  const preparing = session?.preparing ?? false;
  useEffect(() => {
    if (preparing) return;
    // The line ran: its chips will not come back.
    if (ownLine.current) letGo(ownLine.current.chips);
    ownLine.current = null;
  }, [preparing]);
  if (restoreLine) {
    restoreLine.current = () => {
      const line = ownLine.current;
      ownLine.current = null;
      if (line === null || box.current?.value) return;
      setText(line.text);
      setChips(cs => [...cs, ...line.chips.filter(c => !cs.some(k => k.marker === c.marker))]);
    };
  }

  useLayoutEffect(() => {
    fitHeight(box.current);
    const el = box.current;
    if (el && caret.current !== null && typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(caret.current, caret.current);
    }
    caret.current = null;
  }, [text]);
  // The placeholder changes with the turn ("Queue a message · Esc stops") and may wrap differently,
  // and a narrower window rewraps the text: both change the height the box needs.
  const placeholder = placeholderFor(mode, busy, locked, upload ? PASTE_KEY : null);
  useLayoutEffect(() => fitHeight(box.current), [placeholder]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // On load, and again when a dialog closes and hands the box back.
  useEffect(() => {
    if (!waiting && !locked) box.current?.focus();
  }, [waiting, locked]);

  // The arrow keys move the selection past the list's visible rows.
  const selected = completion?.selected ?? null;
  useLayoutEffect(() => {
    if (selected === null) return;
    const row = completionList.current?.children[selected] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  // The whole card is the box's target, but for its controls; preventDefault keeps a press from
  // blurring the box first, which would close an open completion list.
  const focusFromCard = (e: { target: EventTarget; preventDefault(): void }) => {
    const target = e.target as Element;
    if (target === box.current || target.closest('button, a, input, [role="menu"]')) return;
    if (!box.current || box.current.disabled) return;
    e.preventDefault();
    box.current.focus();
  };

  const replaceText = (next: string, at = next.length) => {
    caret.current = at;
    setText(next);
  };

  const requestCompletion = (value: string): void => {
    const seq = ++completionSeq.current;
    if (!wantsCompletion(value)) {
      setCompletion(null);
      return;
    }
    void send({ type: 'complete', text: completionRequestText(value) }).then(result => {
      if (seq !== completionSeq.current) return;
      const list =
        result.kind === 'ok' && result.reply && !('scope' in result.reply) ? result.reply : null;
      setCompletion(list && list.items.length > 0 ? { list, selected: 0 } : null);
    });
  };
  const closeCompletion = () => {
    completionSeq.current++;
    setCompletion(null);
  };

  // One send at a time, so a held or double Enter cannot submit the same text twice.
  const sending = useRef(false);
  const submit = async (value: string): Promise<void> => {
    if (sending.current || locked) return;
    if (stillReading(chips)) {
      setError('An image is still being read.');
      return;
    }
    sending.current = true;
    closeCompletion();
    const pastes = pastesFor(value, parked);
    const images = imagesFor(value, chips);
    const message: ClientMessage = {
      type: 'submit',
      text: value,
      ...(session ? { mode } : {}),
      ...(pastes.length > 0 ? { pastes } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    const result = await send(message).finally(() => {
      sending.current = false;
    });
    const failure = sendFailure(result);
    setError(failure);
    if (failure) return;
    const ranAlone =
      session !== null && session.status === 'idle' && !session.preparing && !session.queue.length;
    const sentChips = chips.filter(c => images.some(i => i.marker === c.marker));
    ownLine.current = ranAlone ? { text: value, chips: sentChips } : null;
    // Cleared only once the server took it, and only if nothing was typed meanwhile.
    const left = box.current?.value === value ? '' : (box.current?.value ?? '');
    setText(current => (current === value ? '' : current));
    setParked(p => afterSend(p, pastes, left));
    // The server took the sent ones; what the box no longer names is let go.
    const sent = new Set(images.map(i => i.marker));
    const kept = chips.filter(c => !sent.has(c.marker) && left.includes(c.marker));
    const dropped = chips.filter(c => !sent.has(c.marker) && !kept.includes(c));
    discard(dropped);
    letGo(dropped);
    // A line another tab's turn holds cannot come back to this box.
    if (!ranAlone) letGo(sentChips);
    setChips(kept);
    setRecall(notRecalling);
  };
  const abort = async (): Promise<void> => setError(sendFailure(await send({ type: 'abort' })));

  const switchTo = async (message: ClientMessage): Promise<void> => {
    setError(sendFailure(await send(message)));
    box.current?.focus();
  };

  const acceptAt = (index: number, fromEnter: boolean): void => {
    if (!completion) return;
    const item = completion.list.items[index];
    if (!item) return;
    const next = acceptCompletion(text, item.value, completion.list.partial);
    closeCompletion();
    // Enter on a line the list would leave as it is sends it, as the TUI does: a fully typed
    // command costs one Enter, not two.
    if (fromEnter && next === text) {
      void submit(text);
      return;
    }
    replaceText(next);
    box.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget;
    const { start, end } = selection(el);
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        isComposing: e.nativeEvent.isComposing,
      },
      {
        text,
        busy,
        completing: completion !== null,
        ...caretLines(el.value, start, end),
      },
    );
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault();
    switch (action) {
      case 'submit':
        void submit(text);
        return;
      case 'newline':
        replaceText(`${text.slice(0, -1)}\n`);
        return;
      case 'abort':
        e.preventDefault();
        void abort();
        return;
      case 'history-older':
      case 'history-newer': {
        const step = recallStep(
          history,
          recall,
          text,
          action === 'history-older' ? 'older' : 'newer',
        );
        if (!step) return;
        e.preventDefault();
        setRecall(step.recall);
        closeCompletion();
        replaceText(step.text);
        return;
      }
      case 'complete-up':
      case 'complete-down': {
        e.preventDefault();
        const step = action === 'complete-down' ? 1 : -1;
        setCompletion(c => {
          if (!c) return c;
          const last = c.list.items.length - 1;
          return { ...c, selected: Math.max(0, Math.min(last, c.selected + step)) };
        });
        return;
      }
      case 'complete-accept':
        e.preventDefault();
        acceptAt(completion?.selected ?? 0, e.key === 'Enter');
        return;
      case 'complete-close':
        e.preventDefault();
        closeCompletion();
        return;
      case 'none':
        return;
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items;
    if (carriesImage(items ? [...items] : null)) {
      e.preventDefault();
      addImages([...(e.clipboardData?.files ?? [])], e.currentTarget);
      return;
    }
    const pasted = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (!isLargePaste(pasted)) return;
    // Parked beside the text, as the TUI parks it: the box holds the marker.
    e.preventDefault();
    const el = e.currentTarget;
    const { start, end } = selection(el);
    const { parked: nextParked, marker } = parkPaste(parked, [el.value, ...history], pasted);
    setParked(nextParked);
    const next = el.value.slice(0, start) + marker + el.value.slice(end);
    replaceText(next, start + marker.length);
    setRecall(notRecalling);
  };

  const discard = (gone: ImageChip[]): void => {
    const ids = gone.flatMap(c => (c.state.kind === 'ready' ? [c.state.id] : []));
    if (ids.length > 0) void send({ type: 'discard', ids });
  };

  const removeChip = (marker: string): void => {
    const chip = chips.find(c => c.marker === marker);
    if (chip) {
      discard([chip]);
      letGo([chip]);
    }
    setChips(cs => cs.filter(c => c.marker !== marker));
    setText(t => withoutMarker(t, marker));
    box.current?.focus();
  };

  // Each image goes up at once and its marker lands at the caret, as a paste's text would.
  const addImages = (files: File[], el: HTMLTextAreaElement): void => {
    if (!upload) {
      setError(IMAGES_UNSUPPORTED);
      return;
    }
    if (mode === 'shell') {
      setError("Can't attach an image in shell mode.");
      return;
    }
    const taken: ImageChip[] = [];
    for (const file of files) {
      const refusal = imageRefusal(file);
      if (refusal) {
        setError(refusal);
        continue;
      }
      if (chips.length + taken.length >= MAX_SUBMIT_IMAGES) {
        setError(`At most ${MAX_SUBMIT_IMAGES} images per message.`);
        break;
      }
      const marker = nextImageMarker([...chips, ...taken], [el.value, ...history]);
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      taken.push({
        marker,
        name: file.name || 'Pasted image',
        size: file.size,
        preview,
        state: { kind: 'reading' },
      });
      void upload(file).then(result => {
        const state: ImageChip['state'] =
          result.kind === 'ok'
            ? { kind: 'ready', id: result.upload.id, chars: result.upload.chars }
            : {
                kind: 'failed',
                error: result.kind === 'signed-out' ? 'Signed out' : result.error,
              };
        if (state.kind === 'failed') setText(t => withoutMarker(t, marker));
        setChips(cs => {
          const live = cs.some(c => c.marker === marker);
          // Removed while it was read: the server's copy goes too.
          if (!live && state.kind === 'ready') void send({ type: 'discard', ids: [state.id] });
          return cs.map(c => (c.marker === marker ? { ...c, state } : c));
        });
      });
    }
    if (taken.length === 0) return;
    setChips(cs => [...cs, ...taken]);
    const { start, end } = selection(el);
    const before = el.value.slice(0, start);
    const lead = before === '' || /\s$/.test(before) ? '' : ' ';
    const inserted = `${lead}${taken.map(c => c.marker).join(' ')} `;
    replaceText(before + inserted + el.value.slice(end), start + inserted.length);
    setRecall(notRecalling);
  };

  const attach = (): void => {
    const next = text && !/\s$/.test(text) ? `${text} @` : `${text}@`;
    replaceText(next);
    box.current?.focus();
    requestCompletion(next);
  };

  const blocked = switchBlocked(session, waiting);
  const modeOptions: PillOption[] = WIRE_MODES.map(m => ({
    value: m,
    label: m,
    dot: modeColor(m),
    checked: m === mode,
  }));
  const models = modelOptions(catalog);
  const canSend = text.trim() !== '' && !waiting && !locked;
  const showStop = busy && text.trim() === '';
  const listId = 'composer-completions';

  return (
    <div className="composer">
      {session?.queue.length ? (
        <ol className="composer-queue" aria-label="Queued prompts">
          {session.queue.map((q, i) => (
            <li key={i} className="composer-queued">
              <span className="composer-tag composer-tag-queued">Queued</span>
              <span className="composer-queued-text">
                {q.content}
                {q.images > 0 ? ` (+${q.images} image${q.images === 1 ? '' : 's'})` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {session?.stage ? (
        <div className="composer-stage" role="status">
          <span className="composer-spinner" aria-hidden="true" />
          {session.stage}…
        </div>
      ) : null}
      {waiting ? <div className="composer-waiting">Answer above to continue.</div> : null}
      <div className="composer-anchor">
        {completion ? (
          <ul
            ref={completionList}
            className="composer-completions"
            id={listId}
            role="listbox"
            aria-label="Completions"
          >
            {completion.list.items.map((item, i) => {
              const { label, detail } = splitDisplay(item.display);
              return (
                <li
                  key={item.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === completion.selected}
                  className="composer-completion"
                  // Keeps focus in the box, so the pick lands where the caret was.
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => acceptAt(i, false)}
                >
                  <span className="composer-completion-label">{label}</span>
                  {detail ? <span className="composer-completion-detail">{detail}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div
          className={`composer-card${locked ? ' composer-card-locked' : ''}`}
          onMouseDown={focusFromCard}
        >
          <textarea
            ref={box}
            className="composer-input"
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={completion ? listId : undefined}
            aria-activedescendant={completion ? `${listId}-${completion.selected}` : undefined}
            rows={1}
            value={text}
            disabled={waiting || locked}
            placeholder={placeholder}
            onChange={e => {
              const value = e.target.value;
              // Deleting a marker drops its image, as in the TUI; a failed one stays until removed.
              const dropped = chips.filter(
                c => c.state.kind === 'ready' && !value.includes(c.marker),
              );
              if (dropped.length > 0) {
                discard(dropped);
                letGo(dropped);
                setChips(cs => cs.filter(c => !dropped.includes(c)));
              }
              if (isTypingEdge(text, e.target.value)) {
                void send({ type: 'typing', text: e.target.value });
              }
              setText(e.target.value);
              setRecall(notRecalling);
              requestCompletion(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={closeCompletion}
            onPaste={onPaste}
            onDragOver={(e: DragEvent) => e.preventDefault()}
            onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
              const items = e.dataTransfer?.items;
              if (!carriesImage(items ? [...items] : null)) return;
              e.preventDefault();
              addImages([...(e.dataTransfer?.files ?? [])], e.currentTarget);
            }}
          />
          {chips.length > 0 ? (
            <ul className="composer-images" aria-label="Attached images">
              {chips.map(chip => {
                const { name, detail } = chipLabel(chip);
                return (
                  <li
                    key={chip.marker}
                    className={`composer-image composer-image-${chip.state.kind}`}
                  >
                    {chip.preview ? (
                      <button
                        type="button"
                        className="composer-image-thumb"
                        aria-label={`View ${chip.marker}`}
                        {...tip('View', { aria: false })}
                        onClick={() => setViewing(chip.marker)}
                      >
                        <img src={chip.preview} alt="" />
                      </button>
                    ) : null}
                    <span className="composer-image-marker">{chip.marker}</span>
                    <span className="composer-image-name">{name}</span>
                    <span
                      className="composer-image-detail"
                      role={chip.state.kind === 'failed' ? 'alert' : undefined}
                    >
                      {detail}
                    </span>
                    <button
                      type="button"
                      className="composer-image-remove"
                      aria-label={`Remove ${chip.marker}`}
                      {...tip('Remove', { aria: false })}
                      onClick={() => removeChip(chip.marker)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="composer-bar">
            <PillMenu
              ariaLabel={`Mode: ${mode}`}
              label={mode}
              dot={modeColor(mode)}
              options={modeOptions}
              disabled={blocked !== null || locked}
              title={blocked ?? undefined}
              onPick={value => {
                if (value !== mode) void switchTo({ type: 'mode', mode: value as Mode });
              }}
            />
            <PillMenu
              ariaLabel={`Model: ${session?.model ?? 'none'}`}
              label={session?.model ?? '…'}
              options={models}
              disabled={blocked !== null || locked || models.length === 0}
              title={blocked ?? undefined}
              onPick={value => {
                const current = models.find(m => m.checked)?.value;
                if (value !== current) void switchTo({ type: 'model', name: value });
              }}
            />
            <button
              type="button"
              className="pill pill-icon"
              aria-label="Attach a file"
              {...tip('Attach a file (@)', { aria: false })}
              disabled={waiting || locked}
              onClick={attach}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13 7.5 8 12.5a3 3 0 0 1-4.2-4.2L9 3a2 2 0 0 1 2.8 2.8L6.7 11a1 1 0 0 1-1.4-1.4L10 5" />
              </svg>
            </button>
            {showStop ? (
              <button
                type="button"
                className="composer-round composer-stop"
                aria-label="Stop"
                aria-keyshortcuts="Escape"
                {...tip('Stop (Esc)', { aria: false })}
                onClick={() => void abort()}
              >
                <span className="composer-stop-square" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="composer-round composer-send"
                aria-label={busy ? 'Queue' : 'Send'}
                aria-keyshortcuts="Enter"
                {...tip(busy ? 'Queue (Enter)' : 'Send (Enter)', { aria: false })}
                disabled={!canSend}
                onClick={() => void submit(text)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {(() => {
        const chip = chips.find(c => c.marker === viewing);
        if (!chip?.preview) return null;
        return (
          <ImagePreview
            src={chip.preview}
            caption={`${chip.marker} ${chipLabel(chip).name}`}
            onClose={() => {
              setViewing(null);
              box.current?.focus();
            }}
          />
        );
      })()}
      {error ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
