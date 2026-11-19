import { commandTail } from '../../display/commandtail.js';
import { CommandChip } from './MessageRow.js';
import { useEffect, useRef, useState } from 'react';
import { prefillLabel, toolTimer, toolVerb } from '../../display/format.js';
import { planWindow } from '../../display/planwindow.js';
import { foldedLiveFields } from '../../display/reasoningfold.js';
import { shimmerBase, shimmerRamp } from '../../display/shimmer.js';
import {
  BRAILLE_SPINNER,
  nextWordIndex,
  SHIMMER_PAUSE,
  SHIMMER_STEP,
  TICK_MS,
  ticksPerWord,
  WORKING_WORDS,
} from '../../display/workingwords.js';
import type { WireLive } from '../protocol.js';
import { GLYPH, NoteBlock, Prose, ReasoningBlock } from './blocks.js';
import { InlineMarkdown } from './Markdown.js';
import { OutputLines } from './OutputLines.js';
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
  return (
    <div className={`busy busy--${tone}`} role="status">
      <span className="busy-spinner" aria-hidden="true">
        {BRAILLE_SPINNER[frame]}
      </span>
      <SweepLabel
        // A new working word opens on a fresh sweep. A harness label keeps its sweep while its
        // numbers move: keyed on the text, "Processing context 41%" restarted at every percent and
        // the glow never crossed the line.
        key={text === null ? label : tone}
        label={label}
        tone={tone}
      />
    </div>
  );
}

// The TUI's glow as a gradient: its colours (display/shimmer.ts, the same resting and peak lightness
// for every state) and its band, the ramp's five stops one character apart, on the dim base. The
// gradient is three labels wide (live.css slides it across), so one character is 1/(3·chars) of it,
// and the band is centred on its middle.
export function sweepGradient(tone: string, chars: number): string {
  const ramp = shimmerRamp(tone);
  const base = shimmerBase(tone);
  const step = 100 / (3 * Math.max(1, chars));
  const half = (ramp.length - 1) / 2;
  const at = (offset: number) => `${(50 + offset * step).toFixed(3)}%`;
  const stops = [
    `${base} 0`,
    `${base} ${at(-half - 1)}`,
    ...ramp.map((c, i) => `${c} ${at(i - half)}`),
    `${base} ${at(half + 1)}`,
    `${base} 100%`,
  ];
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// The state's colour as app.css defines it; null outside a browser (a render test), where the
// stylesheet's own gradient stands.
function toneHex(tone: string): string | null {
  if (typeof getComputedStyle !== 'function' || !document.documentElement) return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--reika-${tone}`);
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : null;
}

// The sweep's pace is set from the label it opened on: re-timed as a count changes length, the
// running animation would jump to another point of its cycle. The band's width is set then too.
function SweepLabel({ label, tone }: { label: string; tone: string }) {
  const [sweepMs] = useState(() => (label.length + SHIMMER_PAUSE) * SHIMMER_STEP * TICK_MS);
  const [glow] = useState(() => {
    const hex = toneHex(tone);
    return hex ? sweepGradient(hex, label.length) : null;
  });
  return (
    <span
      className="busy-label"
      style={{ animationDuration: `${sweepMs}ms`, ...(glow ? { backgroundImage: glow } : {}) }}
    >
      {label}
    </span>
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

// Folded by the TUI's rule (display/planwindow.ts) unless the user asks for every step; a page has room
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
  command = null,
}: {
  live: WireLive;
  busy: boolean;
  planShown: boolean;
  clockOffset?: number | null;
  // The running bash call's command (livecommand.ts), drawn as its result will draw it.
  command?: string | null;
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
  const showPending = !!pending && pendingRowDue(pending.since, now);
  // Output streamed by a call still inside its delay belongs to the block the delay holds back.
  const holding = !!pending && !showPending;
  const elapsed = pending ? pendingElapsedMs(pending.since, now) : 0;
  // A running command draws as its result will: the `$ command` line, then the same tail of its
  // output, so the commit changes the verb and moves nothing.
  const commandBlock =
    showPending && pending?.name === 'bash' && command !== null
      ? { text: command, ...commandTail(tool?.name === 'bash' ? tool.output : '') }
      : null;
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
      {commandBlock ? <CommandChip command={commandBlock} /> : null}
      {live.note ? (
        <div className="row">
          <NoteBlock note={folded.content} reasoning={folded.reasoning || undefined} />
        </div>
      ) : // One row, as the committed message is: `.reasoning + .prose` spaces the reply under its
      // Thinking, where two rows put a row's margin between them and the commit moved it up.
      folded.reasoning.trim() || folded.content.trim() ? (
        <div className="row">
          {folded.reasoning.trim() ? <ReasoningBlock text={folded.reasoning} live /> : null}
          {folded.content.trim() ? <Prose text={folded.content} /> : null}
        </div>
      ) : null}
      {tool && tool.output && !commandBlock && !holding ? (
        // Under the command chip's indent only for bash, where the committed output lands.
        <OutputLines
          className={`live-tool${tool.name === 'bash' ? ' live-tool--command' : ''}`}
          text={tool.output}
        />
      ) : null}
      {plan}
    </section>
  );
}
