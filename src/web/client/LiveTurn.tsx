import { useEffect, useRef, useState } from 'react';
import { prefillLabel, toolTimer, toolVerb } from '../../ui/format.js';
import { planWindow } from '../../ui/planwindow.js';
import { foldedLiveFields } from '../../ui/reasoningfold.js';
import {
  BRAILLE_SPINNER,
  nextWordIndex,
  SHIMMER_PAUSE,
  SHIMMER_STEP,
  TICK_MS,
  ticksPerWord,
  WORKING_WORDS,
} from '../../ui/workingwords.js';
import type { WireLive } from '../protocol.js';
import { GLYPH, NoteBlock, Prose, ReasoningBlock } from './blocks.js';
import { InlineMarkdown } from './Markdown.js';
import {
  PENDING_ROW_DELAY_MS,
  pendingElapsedMs,
  pendingRowDue,
  serverTime,
} from './pendingdelay.js';
import './live.css';

// The running turn, as the TUI's live region draws it (Scrollback, App, PlanProgress), directly
// under the last committed row so each block sits where its committed row will land.

type PlanStep = NonNullable<WireLive['plan']>[number];

// The one busy line, in the TUI's order: a definite harness action before the soft spin hint.
// Null text is the ordinary turn, which rotates the working verbs as the TUI's Working does; a
// harness state is information and keeps its wording.
export function busyLabel(live: WireLive): { text: string | null; tone: string } {
  const prefill = prefillLabel(live.promptProgress ?? undefined);
  if (live.typechecking) return { text: 'Typechecking', tone: 'info' };
  if (prefill) return { text: prefill, tone: 'prefill' };
  if (live.recovering) return { text: 'Recovering from a loop', tone: 'info' };
  if (live.looping) return { text: 'Thinking — may be looping', tone: 'warning' };
  if (live.note) return { text: 'Writing compaction note', tone: 'info' };
  if (live.subagent) return { text: 'Subagent working', tone: 'subagent' };
  return { text: null, tone: 'accent' };
}

// The TUI's working line: a braille spinner, and a glow that sweeps the label at the TUI's pace
// (one char per SHIMMER_STEP ticks, then a pause), restarted for each new word.
export function BusyLine({
  text,
  tone,
  words,
}: {
  text: string | null;
  tone: string;
  words: boolean;
}) {
  const pool = text === null && words ? WORKING_WORDS : null;
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(() => (pool ? Math.floor(Math.random() * pool.length) : 0));
  const since = useRef(0);
  useEffect(() => {
    let tick = 0;
    const id = setInterval(() => {
      tick++;
      setFrame(tick % BRAILLE_SPINNER.length);
      if (!pool) return;
      setWord(w => {
        if (tick - since.current < ticksPerWord(pool[w % pool.length]!)) return w;
        since.current = tick;
        return nextWordIndex(w, pool.length);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [pool]);
  const label = `${text ?? (pool ? pool[word % pool.length]! : 'Working')}…`;
  const sweepMs = (label.length + SHIMMER_PAUSE) * SHIMMER_STEP * TICK_MS;
  return (
    <div className={`busy busy--${tone}`} role="status">
      <span className="busy-spinner" aria-hidden="true">
        {BRAILLE_SPINNER[frame]}
      </span>
      <span
        // Keyed on the label, so a new word opens on a fresh sweep rather than mid-glow.
        key={label}
        className="busy-label"
        style={{ animationDuration: `${sweepMs}ms`, ['--busy-chars' as string]: label.length }}
      >
        {label}
      </span>
    </div>
  );
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
  clockOffset = null,
  workingWords = false,
}: {
  live: WireLive;
  busy: boolean;
  planShown: boolean;
  clockOffset?: number | null;
  workingWords?: boolean;
}) {
  const pending = busy ? live.pending : null;
  const due = pending ? pending.since + PENDING_ROW_DELAY_MS : 0;
  const before = due > serverTime(Date.now(), clockOffset);
  const now = serverTime(useNow(!!pending, before ? PENDING_ROW_DELAY_MS : 1000), clockOffset);
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
  const showPending = !!pending && pendingRowDue(pending.since, now, !!tool?.output);
  const elapsed = pending ? pendingElapsedMs(pending.since, now) : 0;
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
              <ReasoningBlock text={folded.reasoning} live />
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
      <BusyLine text={label.text} tone={label.tone} words={workingWords} />
    </section>
  );
}
