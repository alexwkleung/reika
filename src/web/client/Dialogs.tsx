import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClientMessage, WireDialog } from '../protocol.js';
import { approvalHeading, diffStat, savedAgo } from './dialogtext.js';
import { shortenMiddle } from './statuschips.js';

const WHERE_MAX_CHARS = 48;
import { DiffView } from './DiffView.js';
import { digitPick } from './keys.js';
import type { Send } from './Composer.js';
import type { OpenDialog } from './store.js';
import './dialogs.css';

// The first open dialog, inline above the input box: one neutral card for every kind, a small
// label saying what is asked, the subject, and real buttons carrying their digit. Each kind sends
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
  kicker,
  title,
  children,
  error,
}: {
  kicker: string;
  title: ReactNode;
  children: ReactNode;
  error: string | null;
}) {
  return (
    <section className="dialog" aria-label={kicker}>
      <div className="dialog-kicker">{kicker}</div>
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

function Action({
  n,
  label,
  onPick,
  disabled,
  primary,
  current,
  autoFocus,
  title,
}: {
  n: number;
  label: string;
  onPick: () => void;
  disabled: boolean;
  primary?: boolean;
  current?: boolean;
  autoFocus?: boolean;
  title?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const kind = primary ? ' dialog-button--primary' : current ? ' dialog-button--current' : '';
  return (
    <button
      ref={ref}
      type="button"
      className={`dialog-button${kind}`}
      disabled={disabled}
      title={title}
      onClick={onPick}
    >
      {label}
      <kbd className="dialog-key" aria-hidden="true">
        {n}
      </kbd>
    </button>
  );
}

// A choice with something to read under it: a question's option, a model, a saved session.
function Row({
  n,
  label,
  detail,
  tag,
  onPick,
  disabled,
  current,
  autoFocus,
}: {
  n: number;
  label: string;
  detail?: string | null;
  tag?: string | null;
  onPick: () => void;
  disabled: boolean;
  current?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={`dialog-row${current ? ' dialog-row--current' : ''}`}
        disabled={disabled}
        onClick={onPick}
      >
        <span className="dialog-row-n" aria-hidden="true">
          {n}
        </span>
        <span className="dialog-row-body">
          <span className="dialog-row-label">
            {label}
            {tag ? <span className="dialog-row-tag">{tag}</span> : null}
          </span>
          {detail ? <span className="dialog-row-detail">{detail}</span> : null}
        </span>
        {current ? (
          <svg className="dialog-row-check" viewBox="0 0 12 12" aria-label="current">
            <path d="m2.5 6.5 2.5 2.5 4.5-5" />
          </svg>
        ) : null}
      </button>
    </li>
  );
}

function Quiet({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button type="button" className="dialog-quiet" disabled={disabled} onClick={onClick}>
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
      <DiffView diff={d.preview} path={d.subject} startLine={d.startLine} />
    </div>
  );
}

function ApprovalDialog({ id, d, send }: { id: string; d: Of<'approval'>; send: Send }) {
  const a = useAnswer(send);
  const [reason, setReason] = useState('');
  const heading = approvalHeading(d.tool, d.subject);
  const stat = d.tool === 'bash' || d.tool === 'fetch_url' ? null : diffStat(d.preview);
  const answers: [string, () => Answer][] = [
    ['Yes', () => ({ type: 'answer', id, kind: 'approval', answer: true })],
    // Approves this one and turns the session's auto-approve on; a warning still prompts after it.
    [
      'Always this session',
      () => ({ type: 'answer', id, kind: 'approval', answer: true, always: true }),
    ],
    [
      reason.trim() ? 'No, with reason' : 'No',
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
      kicker="Approval needed"
      error={a.error}
      title={
        <>
          <span className="dialog-verb">{heading.verb}</span>
          {heading.target ? <span className="dialog-target">{heading.target}</span> : null}
          {heading.where ? (
            <span className="dialog-where" title={heading.where}>
              in {shortenMiddle(heading.where, WHERE_MAX_CHARS)}
            </span>
          ) : null}
          {stat ? (
            <span className="dialog-stat">
              <span className="dialog-stat-added">+{stat.added}</span>{' '}
              <span className="dialog-stat-removed">−{stat.removed}</span>
            </span>
          ) : null}
        </>
      }
    >
      <Preview d={d} />
      {(d.warnings ?? []).length > 0 ? (
        <ul className="dialog-warnings" aria-label="Warnings">
          {d.warnings!.map((w, i) => (
            <li key={i} className="dialog-warning">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.5 14 13H2L8 2.5Z" />
                <path d="M8 6.5v3M8 11.2v.1" />
              </svg>
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dialog-actions">
        {answers.map(([label], i) => (
          <Action
            key={i}
            n={i + 1}
            label={label}
            primary={i === 0}
            disabled={a.disabled}
            autoFocus={i === 0}
            title={
              i === 1
                ? 'Approve this and every ordinary action for the rest of the session. A warning still asks.'
                : undefined
            }
            onPick={() => pick(i)}
          />
        ))}
      </div>
      <input
        className="dialog-input"
        type="text"
        aria-label="Reason to send with No"
        placeholder="Tell the model why (optional, sent with No)"
        value={reason}
        disabled={a.disabled}
        onChange={e => setReason(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && reason.trim()) pick(2);
        }}
      />
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
  const sendFree = () => {
    if (free.trim()) {
      void a.answer({ type: 'answer', id, kind: 'question', answer: { text: free.trim() } });
    }
  };
  useDigitKeys(d.options.length, pick, a.disabled);
  return (
    <Frame kicker="The model asks" error={a.error} title={<span>{d.question}</span>}>
      <ol className="dialog-rows">
        {d.options.map((o, i) => (
          <Row
            key={i}
            n={i + 1}
            label={o.label}
            detail={o.description}
            tag={o.recommended ? 'Recommended' : null}
            disabled={a.disabled}
            autoFocus={i === 0}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-free">
        <input
          className="dialog-input"
          type="text"
          aria-label="Something else"
          placeholder="Something else…"
          value={free}
          disabled={a.disabled}
          onChange={e => setFree(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') sendFree();
          }}
        />
        <button
          type="button"
          className="dialog-button"
          disabled={a.disabled || !free.trim()}
          onClick={sendFree}
        >
          Send answer
        </button>
      </div>
      {/* Not on Escape, as in the TUI: skipping tells the model to go on without you. */}
      <div className="dialog-footer">
        <Quiet
          label="Skip question"
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'question', answer: null })}
        />
      </div>
    </Frame>
  );
}

function ConfirmDialog({
  id,
  d,
  send,
  onDontSend,
}: {
  id: string;
  d: Of<'confirm'>;
  send: Send;
  onDontSend: () => void;
}) {
  const a = useAnswer(send);
  const pick = (choice: number) => void a.answer({ type: 'answer', id, kind: 'confirm', choice });
  useDigitKeys(d.options.length, pick, a.disabled);
  return (
    <Frame
      kicker="Before sending"
      error={a.error}
      title={
        <>
          <span className="dialog-verb">{d.title}</span>
          <span className="dialog-subtitle">{d.subtitle}</span>
        </>
      }
    >
      {d.details.length > 0 ? (
        <ul className="dialog-details">
          {d.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="dialog-actions">
        {d.options.map((label, i) => (
          <Action
            key={i}
            n={i + 1}
            label={label}
            current={i === d.initial}
            disabled={a.disabled}
            autoFocus={i === d.initial}
            onPick={() => pick(i)}
          />
        ))}
        <Quiet
          label="Don’t send"
          disabled={a.disabled}
          onClick={() => {
            // Before the answer: the line's preparation ends with it, and the box decides whether
            // the line was its own while that is still known.
            onDontSend();
            void a.answer({ type: 'answer', id, kind: 'confirm', choice: 'abort' });
          }}
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
    <Frame kicker="Switch model" error={a.error} title={<span>Pick a model for this session</span>}>
      <ol className="dialog-rows">
        {d.targets.map((t, i) => (
          <Row
            key={t.name}
            n={i + 1}
            label={t.name}
            detail={t.group ?? (t.name === t.model.toLowerCase() ? null : t.model)}
            tag={t.adhoc ? 'not in config' : null}
            current={t.active}
            disabled={a.disabled}
            autoFocus={i === active}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-footer">
        <Quiet
          label="Cancel"
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
  const now = Date.now();
  return (
    <Frame kicker="Resume" error={a.error} title={<span>{d.heading}</span>}>
      {d.entries.length === 0 ? <div className="dialog-empty">No saved sessions.</div> : null}
      <ol className="dialog-rows dialog-rows--scroll">
        {d.entries.map((e, i) => (
          <Row
            key={e.path}
            n={i + 1}
            label={e.title ?? 'untitled'}
            detail={[savedAgo(e.savedAt, now), `${e.messageCount} msgs`, e.model]
              .filter(Boolean)
              .join(' · ')}
            tag={e.chat ? 'chat' : null}
            disabled={a.disabled}
            autoFocus={i === 0}
            onPick={() => pick(i)}
          />
        ))}
      </ol>
      <div className="dialog-footer">
        <Quiet
          label="Cancel"
          disabled={a.disabled}
          onClick={() => void a.answer({ type: 'answer', id, kind: 'session', path: null })}
        />
      </div>
    </Frame>
  );
}

export function Dialogs({
  dialogs,
  send,
  onDontSend = () => {},
}: {
  dialogs: OpenDialog[];
  send: Send;
  // A confirm's "Don't send": the input box takes its line back if it was this tab's.
  onDontSend?: () => void;
}) {
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
      return <ConfirmDialog key={id} id={id} d={d} send={send} onDontSend={onDontSend} />;
    case 'model':
      return <ModelDialog key={id} id={id} d={d} send={send} />;
    case 'session':
      return <SessionDialog key={id} id={id} d={d} send={send} />;
  }
}
