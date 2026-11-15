import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { ClientMessage, WireState } from '../protocol.js';
import { connectionNotice } from './connection.js';
import { carriesImage, composerKeyAction, IMAGES_UNSUPPORTED } from './keys.js';
import type { SendResult } from './send.js';
import './composer.css';

// The input box: functional, not designed. Enter sends, Shift+Enter is a newline; while a turn
// runs a prompt is queued by the server, and Escape on an empty box or Stop aborts the turn.

export type Send = (message: ClientMessage) => Promise<SendResult>;

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

// Grows with its content up to the CSS max-height, then scrolls.
function fitHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function Composer({
  send,
  busy,
  queue,
  waiting,
}: {
  send: Send;
  busy: boolean;
  queue: WireState['queue'];
  // A dialog is open above: it takes the answer, as the TUI intercepts typing for one.
  waiting: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => fitHeight(box.current), [text]);
  // On load, and again when a dialog closes and hands the box back.
  useEffect(() => {
    if (!waiting) box.current?.focus();
  }, [waiting]);

  // One send at a time, so a held or double Enter cannot submit the same text twice.
  const sending = useRef(false);
  const submit = async (value: string): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    const result = await send({ type: 'submit', text: value }).finally(() => {
      sending.current = false;
    });
    const failure = sendFailure(result);
    setError(failure);
    // Cleared only once the server took it, and only if nothing was typed meanwhile.
    if (!failure) setText(current => (current === value ? '' : current));
  };
  const abort = async (): Promise<void> => setError(sendFailure(await send({ type: 'abort' })));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        isComposing: e.nativeEvent.isComposing,
      },
      text,
      busy,
    );
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault();
    if (action === 'submit') void submit(text);
    else if (action === 'abort') {
      e.preventDefault();
      void abort();
    }
  };
  const refuseImage = (items: DataTransferItemList | undefined, e: { preventDefault(): void }) => {
    if (!carriesImage(items ? [...items] : null)) return;
    e.preventDefault();
    setError(IMAGES_UNSUPPORTED);
  };

  return (
    <div className="composer">
      {queue.length > 0 ? (
        <ol className="composer-queue" aria-label="Queued prompts">
          {queue.map((q, i) => (
            <li key={i} className="composer-queued">
              <span className="composer-queued-label">queued</span>
              {q.content}
              {q.images > 0 ? ` (+${q.images} image${q.images === 1 ? '' : 's'})` : ''}
            </li>
          ))}
        </ol>
      ) : null}
      {waiting ? <div className="composer-waiting">A question is waiting above.</div> : null}
      <div className="composer-row">
        <textarea
          ref={box}
          className="composer-input"
          aria-label="Message"
          rows={1}
          value={text}
          disabled={waiting}
          placeholder={busy ? 'Queue a message (Esc stops)' : 'Message reika'}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) =>
            refuseImage(e.clipboardData?.items, e)
          }
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent<HTMLTextAreaElement>) => refuseImage(e.dataTransfer?.items, e)}
        />
        {busy ? (
          <button type="button" className="composer-stop" onClick={() => void abort()}>
            Stop
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
