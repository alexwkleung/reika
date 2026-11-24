import { memo, type ReactNode } from 'react';
import {
  changeLabel,
  diffStatRuns,
  displayProse,
  toolLabel,
  toolTimer,
} from '../../display/format.js';
import { foldedAssistantFields } from '../../display/reasoningfold.js';
import { elidedReadSummary, noticeLead } from '../../display/scrollbackrules.js';
import type { WireMessage } from '../protocol.js';
import {
  GLYPH,
  NoteBlock,
  PlanChecksBlock,
  Prose,
  ReasoningBlock,
  WorkedRow,
  reasoningText,
} from './blocks.js';
import { DiffView } from './DiffView.js';
import { OutputLines } from './OutputLines.js';
import { callParts, summaryParts, type Part } from './toolparts.js';
import './transcript.css';

// One committed message, by Scrollback.tsx's content rules (renderMessage): what each kind shows
// and in what order. The terminal's wrapping and row budgets are CSS's job here.

type Of<R extends WireMessage['role']> = Extract<WireMessage, { role: R }>;

function UserRow({ m }: { m: Of<'user'> }) {
  const nested = !!m.nested;
  return (
    <div
      className={`row row-user${nested ? ' row-user--nested' : ''}${m.meta ? ' row-user--meta' : ''}`}
    >
      <span className="sr-only">{nested ? 'Subagent task: ' : 'You: '}</span>
      <div className="row-user-text">{m.display ?? m.content}</div>
    </div>
  );
}

// A call or a result as words, the literal they act on as code, and the detail muted.
function Parts({ parts }: { parts: Part[] }) {
  return parts.map((p, i) =>
    p.code ? (
      <code key={i} className="tool-literal">
        {p.text}
      </code>
    ) : (
      <span
        key={i}
        className={p.side ? `tool-detail stat-${p.side}` : p.muted ? 'tool-detail' : undefined}
      >
        {p.text}
      </span>
    ),
  );
}

function ToolCalls({ calls }: { calls: NonNullable<Of<'assistant'>['toolCalls']> }) {
  return (
    <div className="calls">
      {calls.map(tc => (
        <div key={tc.id} className="call">
          <span className="call-marker" aria-hidden="true">
            {GLYPH.call}
          </span>
          <span className="call-name">{toolLabel(tc.name)}</span>
          <span className="call-args">
            <Parts parts={callParts(tc.name, tc.args)} />
          </span>
        </div>
      ))}
    </div>
  );
}

// The frozen stream of a discarded round, muted: it was drawn live and then set aside.
function FrozenRow({ m }: { m: Of<'assistant'> }) {
  if (m.discarded === 'note') {
    return (
      <div className="row row-frozen">
        <NoteBlock note={m.content} reasoning={m.reasoning} />
      </div>
    );
  }
  return (
    <div className="row row-frozen">
      {m.reasoning ? <ReasoningBlock text={m.reasoning} /> : null}
      {m.content.trim() ? <Prose text={m.content} /> : null}
    </div>
  );
}

function AssistantRow({ m }: { m: Of<'assistant'> }) {
  if (m.discarded) return <FrozenRow m={m} />;
  if (m.compactionNote) {
    return (
      <div className="row">
        <NoteBlock note={m.content ?? ''} reasoning={m.reasoning} />
      </div>
    );
  }
  // The display-only fold (display/reasoningfold.ts), skipped for a plan-checks message: its offset
  // indexes into `content`, and the fold would move the bytes it counts.
  const folded = m.planChecks
    ? { reasoning: m.reasoning, content: m.content }
    : foldedAssistantFields(m as Parameters<typeof foldedAssistantFields>[0]);
  const prose = m.planChecks
    ? folded.content.slice(0, m.planChecks.at)
    : displayProse(folded.content, m.interrupted);
  const hasReasoning = !!folded.reasoning && !!reasoningText(folded.reasoning);
  // An abort before any output leaves nothing above the closing line, which says it.
  if (m.interrupted && !hasReasoning && !prose.trim() && !m.nested) return null;
  return (
    <div className="row row-assistant">
      {hasReasoning ? <ReasoningBlock text={folded.reasoning!} /> : null}
      {prose.trim() ? <Prose text={prose} /> : null}
      {m.planChecks ? <PlanChecksBlock checks={m.planChecks} /> : null}
      {m.toolCalls && m.toolCalls.length > 0 ? <ToolCalls calls={m.toolCalls} /> : null}
      {m.sources && m.sources.length > 0 ? (
        <div className="sources">{`Sources: ${m.sources.join(', ')}`}</div>
      ) : null}
      {/* A top-level turn's line is the transcript's; a subagent's closes its nested block here. */}
      {m.durationMs !== undefined && m.nested ? (
        <WorkedRow durationMs={m.durationMs} interrupted={m.interrupted} />
      ) : null}
    </div>
  );
}

// Also the running command's live block (LiveTurn), so a result commits onto the same rows.
export function CommandChip({ command }: { command: NonNullable<Of<'tool'>['command']> }) {
  return (
    <div className="tool-block command">
      <div className="command-line">
        <span className="command-prompt" aria-hidden="true">
          {GLYPH.shell}
        </span>
        <span className="sr-only">Command: </span>
        {command.text}
      </div>
      {command.outputTail ? (
        <div className="command-output">
          {/* Above the lines: they are the run's last ones, so what was dropped came before. */}
          {command.outputTruncated ? (
            <div className="command-omitted">…(earlier output omitted)</div>
          ) : null}
          <OutputLines className="command-tail" text={command.outputTail} />
        </div>
      ) : null}
    </div>
  );
}

function Changes({ changes }: { changes: NonNullable<Of<'tool'>['changes']> }) {
  return (
    <div className="tool-block changes">
      {changes.files.map(f => (
        <div key={f.path} className="change">
          <div className="change-head">
            <span className="change-path">{f.path}</span>
            <span className="change-label">
              {diffStatRuns(` ${changeLabel(f)}`).map((r, i) => (
                <span key={i} className={r.side ? `stat-${r.side}` : undefined}>
                  {r.text}
                </span>
              ))}
            </span>
          </div>
          {f.hunks.map((h, i) => (
            <DiffView
              key={i}
              diff={h.text}
              path={f.path}
              startLine={h.startLine}
              oldStartLine={h.oldStartLine}
            />
          ))}
          {f.omitted ? <div className="change-more">{`…(${f.omitted} more lines)`}</div> : null}
        </div>
      ))}
      {changes.more > 0 ? (
        <div className="change-more">{`…${changes.more} more files changed`}</div>
      ) : null}
    </div>
  );
}

function ToolRow({ m, groupedReads }: { m: Of<'tool'>; groupedReads: boolean }) {
  // The chip times only a command result (#585): `command` is what a bash result carries.
  const duration = m.command ? toolTimer('bash', m.durationMs) : '';
  return (
    <div className="row-tool-body">
      <div className="tool-summary">
        <span className="tool-marker" aria-hidden="true">
          {GLYPH.toolResult}
        </span>
        <span className="tool-summary-text">
          <Parts parts={summaryParts(elidedReadSummary(m.summary ?? '', groupedReads))} />
        </span>
        {duration ? <span className="tool-duration">{duration}</span> : null}
      </div>
      {m.diff ? (
        <div className="tool-block">
          <DiffView diff={m.diff.text} path={m.diff.path} startLine={m.diff.startLine} />
        </div>
      ) : null}
      {m.command ? <CommandChip command={m.command} /> : null}
      {m.changes ? <Changes changes={m.changes} /> : null}
    </div>
  );
}

// A line of only `─` is a divider the TUI draws in characters (/stats); here it is a real rule, so
// a narrow page does not wrap it onto two lines.
const DIVIDER_LINE = /\n?^─{4,}$\n?/m;

function noticeBody(text: string): ReactNode {
  const parts = text.split(DIVIDER_LINE);
  if (parts.length === 1) return text;
  return parts.flatMap((part, i) =>
    i === 0 ? [part] : [<span key={i} className="row-system-rule" role="separator" />, part],
  );
}

function SystemRow({ m }: { m: Of<'system'> }) {
  const tone = m.tone ?? 'default';
  const marker = m.tone === 'warn' ? GLYPH.noticeWarn : GLYPH.notice;
  const emphasis = m.emphasis ?? (m.tone === 'warn' ? 'lead' : undefined);
  // The lead takes the marker's colour and the rest stays muted; a whole tinted line read as a blob.
  const lead = emphasis === 'lead' ? noticeLead(m.content) : '';
  return (
    <div
      className={`row row-system row-system--${tone}${emphasis === 'line' ? ' row-system--line' : ''}`}
    >
      <span className="row-system-marker" aria-hidden="true">
        {marker}
      </span>
      <span className="row-system-text">
        {lead ? <span className="row-system-lead">{lead}</span> : null}
        {noticeBody(m.content.slice(lead.length))}
      </span>
    </div>
  );
}

function ErrorRow({ m }: { m: Of<'error'> }) {
  // Plain text, not markdown: an endpoint's error body is JSON full of markdown characters.
  return (
    <div className="row row-error">
      <span className="row-error-marker" aria-hidden="true">
        {GLYPH.call}
      </span>
      <span className="row-error-label">Error: </span>
      <span className="row-error-text">{m.content}</span>
    </div>
  );
}

function ShellRow({ m }: { m: Of<'shell'> }) {
  const output = m.output.trimEnd();
  return (
    <div className="row row-shell">
      <div className="command-line">
        <span className="command-prompt" aria-hidden="true">
          {GLYPH.shell}
        </span>
        {m.command}
      </div>
      {output ? <OutputLines className="command-tail" text={output} /> : null}
    </div>
  );
}

function render(m: WireMessage, groupedReads: boolean): ReactNode {
  switch (m.role) {
    case 'user':
      return <UserRow m={m} />;
    case 'assistant':
      return <AssistantRow m={m} />;
    case 'tool':
      return <ToolRow m={m} groupedReads={groupedReads} />;
    case 'system':
      return <SystemRow m={m} />;
    case 'error':
      return <ErrorRow m={m} />;
    case 'shell':
      return <ShellRow m={m} />;
    case 'compaction':
      // The TUI draws nothing for one: a scrollback never holds it.
      return null;
    default:
      return <div className="row row-unknown">{JSON.stringify(m)}</div>;
  }
}

// Memoised on the message object and two booleans: the store keeps a committed message's identity,
// so a new row or a live update re-renders none of the rows above.
export const MessageRow = memo(function MessageRow({
  message,
  gap,
  groupedReads,
}: {
  message: WireMessage;
  gap: boolean;
  groupedReads: boolean;
}) {
  const inner = render(message, groupedReads);
  if (inner === null) return null;
  if (message.role !== 'tool') return inner;
  return <div className={`row row-tool${gap ? ' row--gap' : ''}`}>{inner}</div>;
});
