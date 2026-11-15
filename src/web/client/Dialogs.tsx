import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toolLabel } from '../../ui/format.js';
import type { ClientMessage, WireDialog } from '../protocol.js';
import { DiffView } from './DiffView.js';
import { digitPick } from './keys.js';
import type { Send } from './Composer.js';
import type { OpenDialog } from './store.js';
import './dialogs.css';

// The first open dialog, inline above the input box. Functional, not designed. Each kind sends
// exactly the `answer` message protocol.ts parseClientMessage accepts.

type Answer = Extract<ClientMessage, { type: 'answer' }>;
type Of<K extends WireDialog['kind']> = Extract<WireDialog, { kind: K }>;

export const ANSWERED_ELSEWHERE = 'Answered in another tab.';

// One answer in flight at a time. A conflict leaves the buttons off: the dialog is gone on the
// server, and it leaves the page with its `resolved` event.
function useAnswer(send: Send) {
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({
    busy: false,
    error: null,
    done: false,
  });
  const inFlight = useRef(false);
  const answer = async (message: Answer): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ busy: true, error: null, done: false });
    const result = await send(message);
    inFlight.current = false;
    if (result.kind === 'ok') setState({ busy: false, error: null, done: true });
    else if (result.kind === 'conflict')
      setState({ busy: false, error: ANSWERED_ELSEWHERE, done: true });
    else if (result.kind === 'signed-out') {
      setState({ busy: false, error: 'This tab is no longer signed in.', done: false });
    } else setState({ busy: false, error: result.error, done: false });
  };
  return { ...state, disabled: state.busy || state.done, answer };
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

// Digits pick a numbered row from anywhere but a text field.
function useDigitKeys(count: number, pick: (index: number) => void, disabled: boolean): void {
  const latest = useRef(pick);
  latest.current = pick;
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const index = digitPick(e.key, isTextField(e.target), count);
      if (index === null) return;
      e.preventDefault();
      latest.current(index);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, disabled]);
}

function Frame({
  title,
  children,
  error,
}: {
  title: ReactNode;
  children: ReactNode;
  error: string | null;
}) {
  return (
    <section className="dialog" aria-label="Waiting for your answer">
      <div className="dialog-title">{title}</div>
      {children}
      {error ? (
        <div className="dialog-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function Choice({
  n,
  label,
  onPick,
  disabled,
  current,
  autoFocus,
  detail,
}: {
  n: number;
  label: string;
  onPick: () => void;
  disabled: boolean;
  current?: boolean;
  autoFocus?: boolean;
  detail?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <li className="dialog-choice">
      <button
        ref={ref}
        type="button"
        className={`dialog-button${current ? ' dialog-button--current' : ''}`}
        disabled={disabled}
        onClick={onPick}
      >
        <span className="dialog-n">{`${n}.`}</span>
        {label}
      </button>
      {detail ? <div className="dialog-detail">{detail}</div> : null}
    </li>
  );
}

function Cancel({
  onClick,
  disabled,
  label = 'Cancel',
}: {
  onClick: () => void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="dialog-button dialog-cancel"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// The TUI draws a bash command as a command, a fetch as a URL, and anything else as the diff it is.
function Preview({ d }: { d: Of<'approval'> }) {
  if (d.tool === 'bash' || d.tool === 'fetch_url') {
    return <pre className="dialog-preview">{d.preview}</pre>;
  }
  return (
    <div className="dialog-preview-diff">
      <DiffView diff={d.preview} startLine={d.startLine} />
    </div>
  );
}

function ApprovalDialog({ id, d, send }: { id: string; d: Of<'approval'>; send: Send }) {
  const a = useAnswer(send);
  const [reason, setReason] = useState('');
  const answers: [string, () => Answer][] = [
    ['Yes', () => ({ type: 'answer', id, kind: 'approval', answer: true })],
    // Approves this one and turns the session's auto-approve on; a warning still prompts after it.
    [
      'Always (this session)',
      () => ({ type: 'answer', id, kind: 'approval', answer: true, always: true }),
    ],
    [
      'No',
      () => ({
        type: 'answer',
        id,
        kind: 'approval',
        answer: reason.trim() ? { feedback: reason.trim() } : false,
      }),
    ],
  ];
  const pick = (i: number) => void a.answer(answers[i]![1]());
  useDigitKeys(answers.length, pick, a.disabled);
  return (
    <Frame
      error={a.error}
      title={
        <>
          <span className="dialog-tool">{toolLabel(d.tool)}</span>
          <span className="dialog-subject">{d.subject}</span>
        </>
      }
    >
      <Preview d={d} />
      {(d.warnings ?? []).map((w, i) => (
        <div key={i} className="dialog-warning">
          <span aria-hidden="true">▲ </span>
          {w}
        </div>
      ))}
      <ol className="dialog-choices">
        {answers.map(([label], i) => (
          <Choice
            key={label}
            n={i + 1}
            label={label}
            disabled={a.disabled}
            autoFocus={i === 0}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <label className="dialog-field">
        <span>Reason to send with No (optional)</span>
        <input
          type="text"
          value={reason}
          disabled={a.disabled}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && reason.trim()) pick(2);
          }}
        />
      </label>
    </Frame>
  );
}

function QuestionDialog({ id, d, send }: { id: string; d: Of<'question'>; send: Send }) {
  const a = useAnswer(send);
  const [free, setFree] = useState('');
  const pick = (index: number) =>
    void a.answer({
      type: 'answer',
      id,
      kind: 'question',
      answer: { text: d.options[index]!.label, index },
    });
  useDigitKeys(d.options.length, pick, a.disabled);
  return (
    <Frame error={a.error} title={<span className="dialog-question">{d.question}</span>}>
      <ol className="dialog-choices">
        {d.options.map((o, i) => (
          <Choice
            key={i}
            n={i + 1}
            label={o.recommended ? `${o.label} (recommended)` : o.label}
            detail={o.description}
            disabled={a.disabled}
            autoFocus={i === 0}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <label className="dialog-field">
        <span>Or type an answer</span>
        <input
          type="text"
          value={free}
          disabled={a.disabled}
          onChange={e => setFree(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && free.trim()) {
              void a.answer({
                type: 'answer',
                id,
                kind: 'question',
                answer: { text: free.trim() },
              });
            }
          }}
        />
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          className="dialog-button"
          disabled={a.disabled || !free.trim()}
          onClick={() =>
            void a.answer({ type: 'answer', id, kind: 'question', answer: { text: free.trim() } })
          }
        >
          Send answer
        </button>
        <Cancel
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'question', answer: null })}
        />
      </div>
    </Frame>
  );
}

function ConfirmDialog({ id, d, send }: { id: string; d: Of<'confirm'>; send: Send }) {
  const a = useAnswer(send);
  const pick = (choice: number) => void a.answer({ type: 'answer', id, kind: 'confirm', choice });
  useDigitKeys(d.options.length, pick, a.disabled);
  return (
    <Frame
      error={a.error}
      title={
        <>
          <span className="dialog-tool">{d.title}</span>
          <span className="dialog-subject">{d.subtitle}</span>
        </>
      }
    >
      {d.details.map((line, i) => (
        <div key={i} className="dialog-detail">
          {line}
        </div>
      ))}
      <ol className="dialog-choices">
        {d.options.map((label, i) => (
          <Choice
            key={i}
            n={i + 1}
            label={label}
            current={i === d.initial}
            disabled={a.disabled}
            autoFocus={i === d.initial}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-actions">
        <Cancel
          label="Cancel (don’t send)"
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'confirm', choice: 'abort' })}
        />
      </div>
    </Frame>
  );
}

function ModelDialog({ id, d, send }: { id: string; d: Of<'model'>; send: Send }) {
  const a = useAnswer(send);
  const pick = (i: number) =>
    void a.answer({ type: 'answer', id, kind: 'model', name: d.targets[i]!.name });
  useDigitKeys(d.targets.length, pick, a.disabled);
  const active = Math.max(
    0,
    d.targets.findIndex(t => t.active),
  );
  return (
    <Frame error={a.error} title={<span className="dialog-tool">Switch model</span>}>
      <ol className="dialog-choices">
        {d.targets.map((t, i) => (
          <Choice
            key={t.name}
            n={i + 1}
            label={`${t.name}${t.active ? ' (current)' : ''}`}
            detail={`${t.model} · ${t.kind}`}
            current={t.active}
            disabled={a.disabled}
            autoFocus={i === active}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-actions">
        <Cancel
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'model', name: null })}
        />
      </div>
    </Frame>
  );
}

function SessionDialog({ id, d, send }: { id: string; d: Of<'session'>; send: Send }) {
  const a = useAnswer(send);
  const pick = (i: number) =>
    void a.answer({ type: 'answer', id, kind: 'session', path: d.entries[i]!.path });
  useDigitKeys(d.entries.length, pick, a.disabled);
  return (
    <Frame error={a.error} title={<span className="dialog-tool">{d.heading}</span>}>
      {d.entries.length === 0 ? <div className="dialog-detail">No saved sessions.</div> : null}
      <ol className="dialog-choices">
        {d.entries.map((e, i) => (
          <Choice
            key={e.path}
            n={i + 1}
            label={e.title ?? 'untitled'}
            detail={`${e.savedAt} · ${e.messageCount} msgs${e.model ? ` · ${e.model}` : ''}`}
            disabled={a.disabled}
            autoFocus={i === 0}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-actions">
        <Cancel
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'session', path: null })}
        />
      </div>
    </Frame>
  );
}

export function Dialogs({ dialogs, send }: { dialogs: OpenDialog[]; send: Send }) {
  const first = dialogs[0];
  if (!first) return null;
  const { id, dialog: d } = first;
  // Keyed by id, so a new dialog starts with fresh answer state.
  switch (d.kind) {
    case 'approval':
      return <ApprovalDialog key={id} id={id} d={d} send={send} />;
    case 'question':
      return <QuestionDialog key={id} id={id} d={d} send={send} />;
    case 'confirm':
      return <ConfirmDialog key={id} id={id} d={d} send={send} />;
    case 'model':
      return <ModelDialog key={id} id={id} d={d} send={send} />;
    case 'session':
      return <SessionDialog key={id} id={id} d={d} send={send} />;
  }
}
