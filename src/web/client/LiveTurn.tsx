import { useEffect, useRef, useState } from 'react';
import { prefillLabel, toolTimer, toolVerb } from '../../ui/format.js';
import { planWindow } from '../../ui/planwindow.js';
import { foldedLiveFields } from '../../ui/reasoningfold.js';
import type { WireLive } from '../protocol.js';
import { GLYPH, NoteBlock, Prose, ReasoningBlock } from './blocks.js';
import { InlineMarkdown } from './Markdown.js';
import {
  PENDING_ROW_DELAY_MS,
  pendingElapsedMs,
  pendingRowDue,
  sightCall,
  type CallSightings,
} from './pendingdelay.js';
import './live.css';

// The running turn, as the TUI's live region draws it (Scrollback, App, PlanProgress), directly
// under the last committed row so each block sits where its committed row will land.

type PlanStep = NonNullable<WireLive['plan']>[number];

// The one busy line, in the TUI's order: a definite harness action before the soft spin hint.
export function busyLabel(live: WireLive): { text: string; tone: string } {
  const prefill = prefillLabel(live.promptProgress ?? undefined);
  if (live.typechecking) return { text: 'Typechecking', tone: 'info' };
  if (prefill) return { text: prefill, tone: 'prefill' };
  if (live.recovering) return { text: 'Recovering from a loop', tone: 'info' };
  if (live.looping) return { text: 'Thinking — may be looping', tone: 'warning' };
  if (live.note) return { text: 'Writing compaction note', tone: 'info' };
  if (live.subagent) return { text: 'Subagent working', tone: 'subagent' };
  return { text: live.phase === 'tool' ? 'Running tools' : 'Thinking', tone: 'accent' };
}

function PlanStepRow({ s, next }: { s: PlanStep; next: boolean }) {
  const state = s.done ? 'done' : s.waived ? 'waived' : next ? 'next' : 'todo';
  const mark = s.done ? GLYPH.check : s.waived ? '~' : next ? GLYPH.next : '·';
  return (
    <li className={`plan-step plan-step--${state}`}>
      <span className="plan-mark" aria-label={state}>
        {mark}
      </span>
      {`${s.n}. `}
      <InlineMarkdown text={s.text} />
    </li>
  );
}

// Folded by the TUI's rule (ui/planwindow.ts) unless the user asks for every step; a page has room
// to show them, so the fold is a default here rather than a ceiling.
export function PlanList({ steps }: { steps: PlanStep[] }) {
  const [all, setAll] = useState(false);
  const done = steps.filter(s => s.done).length;
  const waived = steps.filter(s => s.waived).length;
  const next = steps.find(s => !s.done && !s.waived);
  const w = planWindow(steps);
  const folds = w.collapsedDone > 0 || w.hiddenTail > 0;
  const shown = all || !folds ? steps : w.visible;
  return (
    <div className="plan">
      <div className="plan-head">
        {`Plan ${done}/${steps.length}`}
        {waived > 0 ? <span className="plan-waived">{` · ${waived} waived`}</span> : null}
      </div>
      <ol className="plan-steps">
        {!all && w.collapsedDone > 0 ? (
          <li className="plan-step plan-step--done plan-step--summary">
            <span className="plan-mark" aria-hidden="true">
              {GLYPH.check}
            </span>
            {`steps ${steps[0]!.n}–${steps[w.collapsedDone - 1]!.n} done`}
          </li>
        ) : null}
        {shown.map(s => (
          <PlanStepRow key={s.n} s={s} next={s === next} />
        ))}
        {!all && w.hiddenTail > 0 ? (
          <li className="plan-step plan-step--summary">{`… ${w.hiddenTail} more`}</li>
        ) : null}
      </ol>
      {folds ? (
        <button
          type="button"
          className="plan-toggle"
          aria-expanded={all}
          onClick={() => setAll(v => !v)}
        >
          {all ? 'Show fewer steps' : `Show all ${steps.length} steps`}
        </button>
      ) : null}
    </div>
  );
}

// A clock for the pending row: ticks only while a call is pending, at the delay and then each
// second for the elapsed chip.
function useNow(active: boolean, interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}

export function LiveTurn({
  live,
  busy,
  planShown,
}: {
  live: WireLive;
  busy: boolean;
  planShown: boolean;
}) {
  const pending = busy ? live.pending : null;
  const sighting = useRef<CallSightings>(null);
  if (pending) sighting.current = sightCall(sighting.current, pending.call, Date.now());
  const due = sighting.current ? sighting.current.seenAt + PENDING_ROW_DELAY_MS : 0;
  const now = useNow(!!pending, due > Date.now() ? PENDING_ROW_DELAY_MS : 1000);
  const plan =
    planShown && live.plan && live.plan.length > 0 ? <PlanList steps={live.plan} /> : null;
  // The checklist outlives its turn (controller onTurnEnd), so what is left shows before the next.
  if (!busy)
    return plan ? (
      <section className="live" aria-label="Plan">
        {plan}
      </section>
    ) : null;
  const folded = live.note
    ? { reasoning: live.reasoning, content: live.content }
    : foldedLiveFields(live.reasoning, live.content);
  const tool = live.tool;
  const showPending =
    !!pending && pendingRowDue(sighting.current, pending.call, now, !!tool?.output);
  const elapsed = pending ? pendingElapsedMs(sighting.current, pending.call, now) : 0;
  const label = busyLabel(live);
  return (
    <section
      className={`live${live.subagent ? ' nest' : ''}`}
      aria-label="Running turn"
      aria-live="off"
    >
      {showPending && pending ? (
        <div className="tool-summary live-pending">
          <span className="tool-marker" aria-hidden="true">
            {GLYPH.toolResult}
          </span>
          <span className="tool-summary-text">{`${toolVerb(pending.name)}…`}</span>
          <span className="tool-duration">{toolTimer(pending.name, elapsed)}</span>
        </div>
      ) : null}
      {live.note ? (
        <div className="row">
          <NoteBlock note={folded.content} reasoning={folded.reasoning || undefined} />
        </div>
      ) : (
        <>
          {folded.reasoning.trim() ? (
            <div className="row">
              <ReasoningBlock text={folded.reasoning} />
            </div>
          ) : null}
          {folded.content.trim() ? (
            <div className="row">
              <Prose text={folded.content} />
            </div>
          ) : null}
        </>
      )}
      {tool && tool.output ? (
        // Under the command chip's indent only for bash, where the committed output lands.
        <pre className={`live-tool${tool.name === 'bash' ? ' live-tool--command' : ''}`}>
          {tool.output}
        </pre>
      ) : null}
      {plan}
      <div className={`busy busy--${label.tone}`} role="status">
        <span className="busy-dot" aria-hidden="true" />
        {label.text}
      </div>
    </section>
  );
}
