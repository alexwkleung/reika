import type { ReactNode } from 'react';
import { formatDurationMs } from '../../ui/format.js';
import type { PlanChecks } from '../../types.js';
import { Markdown } from './Markdown.js';

// Blocks that both a committed row and the live turn draw, so a streamed block and the row it
// commits as look the same.

// The TUI's markers (ui/glyphs.ts). Text, so they read and copy as the terminal's do.
export const GLYPH = {
  call: '⏺',
  toolResult: '↳',
  bar: '▎',
  notice: '❯',
  noticeWarn: '⟳',
  check: '✓',
  next: '▸',
  shell: '$',
} as const;

// Lines a collapsed Thinking block keeps in view: the end of a thought is where it lands.
export const REASONING_TAIL_LINES = 3;

// Blank-line runs and edge whitespace would become empty rows inside the bar (ui/Scrollback.tsx
// reasoningLines does the same).
export function reasoningText(text: string): string {
  return text.replace(/\n\s*\n/g, '\n').replace(/^\s*\n|\s+$/g, '');
}

// Collapsed to its last lines behind a native <details>, so expanding needs no state of ours.
export function ReasoningBlock({
  text,
  tone = 'reasoning',
}: {
  text: string;
  tone?: 'reasoning' | 'info';
}) {
  const lines = reasoningText(text).split('\n');
  const long = lines.length > REASONING_TAIL_LINES;
  const label = <span className="reasoning-label">Thinking</span>;
  return (
    <div className={`reasoning reasoning--${tone}`}>
      {long ? (
        <>
          <details className="reasoning-details">
            <summary>
              {label}
              <span className="reasoning-more">{` · ${lines.length} lines`}</span>
            </summary>
            <div className="reasoning-text">{lines.join('\n')}</div>
          </details>
          <div className="reasoning-text reasoning-tail">
            <span className="reasoning-ellipsis">…</span>
            {'\n' + lines.slice(-REASONING_TAIL_LINES).join('\n')}
          </div>
        </>
      ) : (
        <>
          <div className="reasoning-head">{label}</div>
          <div className="reasoning-text">{lines.join('\n')}</div>
        </>
      )}
    </div>
  );
}

// Assistant prose wears the call glyph in a quieter colour, so a turn reads as one sequence of
// steps (#497).
export function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <span className="prose-marker" aria-hidden="true">
        {GLYPH.call}
      </span>
      <Markdown text={text} />
    </div>
  );
}

// A compaction note behind one info bar: its Thinking, then the note under a label (#498).
export function NoteBlock({ note, reasoning }: { note: string; reasoning?: string }) {
  return (
    <div className="note">
      {reasoning ? <ReasoningBlock text={reasoning} tone="info" /> : null}
      {note.trim() ? (
        <div className="note-body">
          <div className="note-label">Compaction note</div>
          <Markdown text={note} />
        </div>
      ) : null}
    </div>
  );
}

export function WorkedRow({ durationMs }: { durationMs: number }) {
  return (
    <div className="row row-worked">
      <span className="row-worked-marker" aria-hidden="true">
        ■
      </span>
      {`Worked for ${formatDurationMs(durationMs)}`}
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function Section({ head, items, hint }: { head: string; items: string; hint: string }) {
  return (
    <div className="checks-section">
      <div className="checks-head">{head}</div>
      <Markdown text={items} />
      <div className="checks-hint">{hint}</div>
    </div>
  );
}

// The plan-commit grounding checks under the plan, in the caution colour (Scrollback
// PlanChecksBlock): the same findings the model reads, cut off the prose above.
export function PlanChecksBlock({ checks }: { checks: PlanChecks }) {
  const sections: ReactNode[] = [];
  if (checks.missing.length > 0) {
    sections.push(
      <Section
        key="missing"
        head={`${plural(checks.missing.length, 'reference')} not found in the codebase:`}
        items={checks.missing.map(s => `\`${s}\``).join(', ')}
        hint="May be new code, or renamed or misremembered. The agent is told to confirm them against the real files before editing."
      />,
    );
  }
  if (checks.deadUrls.length > 0) {
    sections.push(
      <Section
        key="urls"
        head={`${plural(checks.deadUrls.length, 'link')} did not resolve:`}
        items={checks.deadUrls.map(d => `\`${d.url}\` (${d.error})`).join(', ')}
        hint="Likely wrong or invented. The agent is told not to rely on them."
      />,
    );
  }
  return (
    <div className="checks">
      <div className="checks-label">Plan check</div>
      {sections}
    </div>
  );
}
