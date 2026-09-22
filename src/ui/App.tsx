import { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Splash } from './Splash.js';
import { Scrollback } from './Scrollback.js';
import { VERSION } from '../version.js';
import { Input } from './Input.js';
import { Working } from './Working.js';
import { PlanProgress, planProgressRows } from './PlanProgress.js';
import type { PlanStep } from '../agent/plantrack.js';
import { Status } from './Status.js';
import { kFormat } from './format.js';
import { resolvePr } from './pr.js';
import { clearIdentity, detectIdentity, enableAnon, isAnon, setIdentity } from './identity.js';
import { theme } from './theme.js';
import { Approval } from './Approval.js';
import {
  CONFIRM_ACCEPT,
  CONFIRM_DECLINE,
  Confirm,
  type ConfirmSpec,
  pastedUrlConfirmSpec,
  skillConfirmSpec,
} from './Confirm.js';
import { Question, questionDialogHeight, type QuestionTyping } from './Question.js';
import {
  inheritProfile,
  loadConfig,
  resolveDefaultMode,
  resolveProfile,
  withProbedLimits,
} from '../config.js';
import {
  needsLimitsProbe,
  probeModelLimits,
  type ModelLimitsProbe,
} from '../provider/modellimits.js';
import {
  loadLastState,
  persistableMode,
  saveLastState,
  startMode,
  startProfile,
} from '../laststate.js';
import { autoApproveForced, autoApproves, effectiveAutoApprove } from '../approval.js';
import { bootstrap } from '../context/bootstrap.js';
import { budgetWarning, formatBudget } from '../context/bundlesize.js';
import { debugLog } from '../debug.js';
import { addFileToIndex } from '../context/files.js';
import { chatTools, defaultTools, minimalTools, planTools } from '../tools/index.js';
import { isOffline } from '../tools/_net.js';
import { PayloadStore } from '../store/payloads.js';
import {
  saveTranscript,
  TRANSCRIPT_VERSION,
  type TranscriptShrinkEvent,
  type TranscriptUsage,
} from '../store/transcript.js';
import { runTurn, type ShrinkCounts, type ShrinkEvent } from '../agent/loop.js';
import { PrefixTrace } from '../agent/prefixtrace.js';
import { compactThreshold } from '../agent/compaction.js';
import { createPrefixWarmer } from '../agent/warm.js';
import { execStream } from '../tools/bash.js';
import { expandMentions } from '../agent/mentions.js';
import { attachImageBlocks, nextImageMarker, type ImageAttachment } from '../agent/attachments.js';
import { expandPastedUrls, planPastedUrls } from '../agent/pastedurls.js';
import { matchSkill, shouldConfirmInject } from '../skillmatch.js';
import { systemOcr } from '../ocr/system.js';
import { clipboardImageSupported, readClipboardImage } from './clipboard.js';
import { isWarmEdge } from './warmtrigger.js';
import { Suggestions } from './Suggestions.js';
import { ModelSelect } from './ModelSelect.js';
import { buildModelTargets, type ModelTarget } from './models.js';
import {
  buildImplementPrompt,
  isMinimalPrompt,
  isSaveCommand,
  nextMode,
  planWritten,
  turnMode,
  turnPromptMode,
  turnTools,
  type Mode,
} from './commands.js';
import { acceptSuggestion, computeSuggestions, type SuggestionState } from './suggest.js';
import { buildSummary, hasActivity, type Approvals } from './summary.js';
import { QueuedList } from './QueuedList.js';
import { queueReceipt, type QueuedMessage } from './queue.js';
import { expandPastes, rememberPaste, type PastedText } from './pastes.js';
import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  Message,
  QuestionAnswer,
  QuestionRequest,
  Usage,
} from '../types.js';

type Phase = 'thinking' | 'tool';
type UIStatus = 'loading' | 'idle' | 'busy' | 'error';

// How long the "Typechecking" indicator lingers after a check settles, so a sub-second warm check
// still reads. Long enough to perceive, short enough not to imply the check is still running.
const TYPECHECK_LINGER_MS = 650;

// Only the startup splash lives in the dedicated header <Static> — Ink honors a
// single <Static>, so appending to this one after the message log's Static takes
// over would render nowhere. /cd and /model report through system lines instead.
type HeaderItem = {
  kind: 'splash';
  model: string;
  cwd: string;
  version: string;
  subagent?: string;
};

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

// The ctrl-v hint earns its place here rather than only on the splash: this is the one surface
// visible at the moment you actually have a screenshot on the clipboard, and it comes back every
// time the buffer empties. Dropped when it can't fit — the input box has ~6 columns of chrome
// (border + padding + prompt) and an over-long placeholder wraps the box to two rows.
function promptPlaceholder(): string {
  const base = 'Type / for commands, @ to attach files';
  if (!clipboardImageSupported()) return base;
  const withHint = `${base}, ctrl-v for images`;
  return withHint.length + 6 <= (process.stdout.columns || 80) ? withHint : base;
}

// A window the harness took off the endpoint changes what the session does (compaction, the
// payload cap), so the user is told where the number came from — a gauge denominator alone
// reads as configured.
// One line for whatever the probe found; undefined when it found nothing worth saying.
function probedLimitsNotice(probe: ModelLimitsProbe): string | undefined {
  const parts: string[] = [];
  if (probe.window) {
    const from = probe.windowSource === 'catalog' ? 'the models.dev catalog' : 'the endpoint';
    parts.push(
      `Context window of ${kFormat(probe.window)} tokens, from ${from} (REIKA_CONTEXT_WINDOW overrides).`,
    );
  }
  if (probe.maxOutput) {
    parts.push(
      `Output capped at ${kFormat(probe.maxOutput)} tokens per reply, from the models.dev catalog.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<UIStatus>('loading');
  const [phase, setPhase] = useState<Phase>('thinking');
  // True while the harness is running a post-edit typecheck; relabels the busy indicator so the
  // verification is visible in the dispatch gap. Human-only — never part of model context.
  const [typechecking, setTypechecking] = useState<boolean>(false);
  // True during a one-round loop-recovery intervention (edit re-grounding or the logit-bias nudge), so
  // the busy indicator shows it's actively recovering. Human-only — the durable record is the system
  // receipt in scrollback.
  const [recovering, setRecovering] = useState<boolean>(false);
  // True while the current reasoning block looks like it may be spinning (long AND repetitive).
  // Relabels the busy indicator so the user can decide to abort (ctrl-c) or wait it out. A soft
  // hint, not an automated cutoff — human-only, never part of model context. See loop.ts.
  const [reasoningSpin, setReasoningSpin] = useState<boolean>(false);
  // Checklist of the plan currently being implemented (#71), snapshotted from the loop's
  // deterministic tracker. Non-null only after an agent turn found a written plan in history;
  // persists between turns so the user can see what's left before continuing. Human-only.
  const [planSteps, setPlanSteps] = useState<PlanStep[] | null>(null);
  const [streaming, setStreaming] = useState<string>('');
  const [streamingReasoning, setStreamingReasoning] = useState<string>('');
  const [streamingTool, setStreamingTool] = useState<string>('');
  // A subagent owns the live region right now (#342): its streamed blocks draw at the nested indent.
  const [subagentLive, setSubagentLive] = useState<boolean>(false);
  // The model is writing a compaction note (#280): nested like a subagent, labelled as itself.
  const [noteLive, setNoteLive] = useState<boolean>(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ReturnType<typeof defaultTools>>(() => defaultTools());
  const [chatToolsList, setChatToolsList] = useState<ReturnType<typeof chatTools>>(() => []);
  const [payloads] = useState(() => new PayloadStore());
  const [elapsed, setElapsed] = useState(0);
  const [totalUsage, setTotalUsage] = useState<Usage>({ promptTokens: 0, completionTokens: 0 });
  // Most recent call's usage (the authoritative current context size + cache hit rate),
  // and the pre-send estimate used to fill the gauge before that real count arrives.
  const [lastUsage, setLastUsage] = useState<Usage | null>(null);
  const [estimatedContext, setEstimatedContext] = useState<number | null>(null);
  // Session-cumulative shrink counts (status chips) and the events behind them (transcript only —
  // a shed lands every few rounds on a small window, so as scrollback lines they would be noise,
  // while a saved file wants the timeline). Refs because the loop reads/writes them from a turn
  // in flight and /save reads them from a handler that may be a render behind (#199).
  const [shrink, setShrink] = useState<ShrinkCounts>({ sheds: 0, folds: 0 });
  const shrinkRef = useRef<ShrinkCounts>({ sheds: 0, folds: 0 });
  const shrinkEventsRef = useRef<TranscriptShrinkEvent[]>([]);
  // Learned char→token calibration for the context estimate, persisted across turns so the
  // first call of each turn (which re-seeds the full history) triggers compaction accurately.
  const calibrationRef = useRef(1);
  // Learned prefill throughput (tokens/second), persisted the same way so a turn's round 0 — its
  // most expensive prefill — can already quote a cost estimate. Undefined until a round reprocesses
  // enough to measure one. See agent/prefillcost.ts.
  const prefillRateRef = useRef<number | undefined>(undefined);
  // Decode throughput (tokens/second) for the status bar's tok/s chip (#204) — the smoothed value
  // in state for display, mirrored into a ref for the same reason as the two learners above: a new
  // turn seeds from it, and a handler that hasn't re-rendered still has to read the latest.
  const [decodeRate, setDecodeRate] = useState<number | undefined>(undefined);
  const decodeRateRef = useRef<number | undefined>(undefined);
  // Session-long so the prefix-cache line prices the turn boundary too (#426); see runTurn's opt.
  const prefixTraceRef = useRef(new PrefixTrace());
  const [pending, setPending] = useState<{
    request: ApprovalRequest;
    resolve: (allow: boolean) => void;
  } | null>(null);
  const [approvalSelected, setApprovalSelected] = useState(0);
  // An `ask_user` question waiting on the user (#198). Modal like Approval, with one difference: the
  // input box stays LIVE underneath once `questionTyping` is set, because the free-text row hands the
  // answer to Input rather than to a field rebuilt in the dialog.
  const [question, setQuestion] = useState<{
    request: QuestionRequest;
    resolve: (answer: QuestionAnswer | null) => void;
  } | null>(null);
  const [questionSelected, setQuestionSelected] = useState(0);
  const [questionTyping, setQuestionTyping] = useState<QuestionTyping | null>(null);
  // The harness asking before submit (#425 skill confirm, #448 pasted-link confirm): one modal
  // slot like Approval, whatever is being asked about. Resolves true to accept (apply the skill,
  // fetch the link), false for "send as typed", or 'abort' (ctrl-c: nothing is sent and the
  // prompt stays in the box).
  const [confirm, setConfirm] = useState<{
    spec: ConfirmSpec;
    resolve: (accept: boolean | 'abort') => void;
  } | null>(null);
  const [confirmSelected, setConfirmSelected] = useState<number>(CONFIRM_DECLINE);
  // The launch mode is the last session's (#365) unless REIKA_DEFAULT_MODE was given at launch
  // (REIKA_PLAN_EXPERIMENT=1 is the legacy alias for plan); a .env value is only the fallback. /plan,
  // /vibe and /agent still toggle it at any time regardless.
  const [mode, setMode] = useState<Mode>(() => startMode(loadLastState()));
  const [activeProfile, setActiveProfile] = useState<string>('default');
  const [headerItems, setHeaderItems] = useState<HeaderItem[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  // Past submissions (oldest→newest) the Input recalls via ArrowUp/ArrowDown,
  // independent of the chat transcript so it spans chat, shell, and commands.
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [suggestionState, setSuggestionState] = useState<SuggestionState | null>(null);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  // Interactive /model picker (bare /model). Modal like Approval: the input is
  // disabled while it's open and the arrow keys drive the list.
  const [modelSelect, setModelSelect] = useState<ModelTarget[] | null>(null);
  const [modelSelected, setModelSelected] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const [approvals, setApprovals] = useState<Approvals>({ approved: 0, declined: 0 });
  const [exitRequested, setExitRequested] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  // null = untouched, so the effective mode falls through to the config default (safe when
  // REIKA_AUTO_APPROVE is unset) — see effectiveAutoApprove.
  const [sessionAutoApprove, setSessionAutoApprove] = useState<boolean | null>(null);
  // Open PR for the checked-out branch, shown in the status bar. Null until resolved,
  // and whenever the branch has no PR (or `gh` can't tell us).
  const [pr, setPr] = useState<number | null>(null);
  // Text extracted from images pasted this turn, keyed by the `[Image N]` marker sitting in the
  // input buffer. Ref-held: the buffer's marker is the visible state, this is just its payload,
  // and re-rendering on paste would fight the Input's own cursor bookkeeping.
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  // Text from pastes too large to sit in the input buffer, keyed by the `[Pasted text #N +412 lines]` marker
  // holding its place there (ui/pastes.ts). Ref-held for the same reason as image attachments.
  // Unlike them it is NOT consumed at submit: the marker is plain text the user can recall from
  // history or leave sitting in a queued message, and it has to still expand when they do.
  const pastedTextsRef = useRef<PastedText[]>([]);
  // Skills already suggested this session. A hint the user declined once is noise the second
  // time — and the user who wanted it typed the slash command instead.
  const suggestedSkillsRef = useRef<Set<string>>(new Set());
  // The skill the next submit is opening, set where that is known — the `/name` command path and
  // routing's auto-inject branch — and consumed by submitToModel, which stamps it on the turn's user
  // message. Compaction needs it to know the turn's opening tool call was mandated by a skill rather
  // than picked by position (#275); no downstream code can tell, since the turn's content is just
  // the skill body.
  const pendingSkillRef = useRef<string | undefined>(undefined);
  // A queued prompt's skill-confirm answer, put back here by the queue drain just before the
  // replay (the way images go back onto imageAttachmentsRef) so the replay routes on the decision
  // taken at keypress instead of asking again at drain, when nobody may be at the desk (#425).
  const queuedSkillRouteRef = useRef<string | null | undefined>(undefined);
  // Same for the pasted-link confirm's answer (#448): fetch or not, decided at keypress.
  const queuedUrlFetchRef = useRef<boolean | undefined>(undefined);
  // Receipts for what submit-time expansion did to the prompt (unattachable image, fetched or
  // dead pasted URL, routed skill). Held rather than pushed so they land *after* the user bubble
  // — the same placement rule the URL grounder follows: a receipt reads as a follow-on to the
  // action, never as an announcement in front of it. Flushed by submitToModel's user echo, which
  // runTurn always emits first, so nothing can strand here.
  const pendingNoticesRef = useRef<Message[]>([]);
  // Profiles whose window probe (#417) never reached the server — llama-server still loading when
  // reika started. Asked again at the next submit, when the turn needs the server up anyway. A
  // probe the server answered without a window is not retried: the answer would not change.
  const windowRetryRef = useRef(new Set<string>());
  // Stage label while a ctrl-v paste is in flight; null when idle. Ephemeral by design — the
  // durable record of what got attached is the system notice the paste ends with.
  const [pasting, setPasting] = useState<string | null>(null);
  const pasteBusyRef = useRef(false);
  // Same idea for submit-time expansion, which blocks on the network when the prompt carries a
  // pasted link. Separate from `pasting` so a ctrl-v mid-submit can't clobber either label.
  const [expanding, setExpanding] = useState<string | null>(null);
  // `status` is still 'idle' during expansion (submitToModel flips it), so without this a second
  // Enter during a slow fetch starts a duplicate turn. Ref, not state: the handler closes over
  // its render's value, so a fast double-press would read a stale `false`.
  const submitBusyRef = useRef(false);
  // Messages typed while the agent is busy (or the session is still booting)
  // wait here and are replayed through the normal onSubmit path in order once
  // the turn ends. queueRef mirrors queue for sync access inside effects.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Speculative KV warm (#81, REIKA_WARM): fires on the first keystroke of a prompt, aborted at
  // submit. Ref-held — the warmer is invisible plumbing and must never trigger a render.
  const warmerRef = useRef(createPrefixWarmer());
  const exitArmedRef = useRef(false);
  exitArmedRef.current = exitArmed;
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);
  // A warm incremental typecheck can return in well under a second; without a floor the indicator
  // flashes too briefly to register. Hold the "Typechecking" state a beat after the check settles so
  // it's actually perceptible. See onTypecheckChange / resetTypecheck.
  const typecheckHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const disarmExit = (): void => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setExitArmed(false);
  };
  const statusRef = useRef<UIStatus>('loading');
  statusRef.current = status;
  const pendingRef = useRef<typeof pending>(null);
  pendingRef.current = pending;
  const questionRef = useRef<typeof question>(null);
  questionRef.current = question;
  const questionSelectedRef = useRef(0);
  questionSelectedRef.current = questionSelected;
  const questionTypingRef = useRef<QuestionTyping | null>(null);
  questionTypingRef.current = questionTyping;
  const approvalSelectedRef = useRef(0);
  approvalSelectedRef.current = approvalSelected;
  const confirmRef = useRef<typeof confirm>(null);
  confirmRef.current = confirm;
  const confirmSelectedRef = useRef<number>(CONFIRM_DECLINE);
  confirmSelectedRef.current = confirmSelected;
  const sessionAutoApproveRef = useRef<boolean | null>(null);
  sessionAutoApproveRef.current = sessionAutoApprove;
  const modeRef = useRef<Mode>('agent');
  modeRef.current = mode;
  const activeProfileRef = useRef('default');
  activeProfileRef.current = activeProfile;
  const inputValueRef = useRef('');
  inputValueRef.current = inputValue;
  const suggestionStateRef = useRef<SuggestionState | null>(null);
  suggestionStateRef.current = suggestionState;
  const suggestionSelectedRef = useRef(0);
  suggestionSelectedRef.current = suggestionSelected;
  const modelSelectRef = useRef<ModelTarget[] | null>(null);
  modelSelectRef.current = modelSelect;
  const modelSelectedRef = useRef(0);
  modelSelectedRef.current = modelSelected;
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // The MODEL-facing history, distinct from `messages` (the scrollback). Same message objects, but
  // it holds only what the model actually sees — the loop appends every user/assistant/tool message
  // it commits — and, critically, it PERSISTS the loop's history rewrites across turns (#183).
  // Compaction and the plan→agent handoff fold spans of it into a `compaction` recap; seeding each
  // turn from `messages` instead (the old `.slice()`) re-expanded those folds, so every turn redid
  // the work, re-paid the context, and rewrote the recap that lives in the system block — a
  // from-token-0 prefill on a local server (measured: ~6 min for 8.4k tokens at 22.9 tok/s). The
  // loop mutates this array in place, so nothing has to be copied back at turn end.
  const modelHistoryRef = useRef<Message[]>([]);
  // Stash for the inactive side of the chat/agent boundary. Shell shares with agent. Model history
  // stashes alongside the scrollback so a round trip through /chat doesn't resurrect folded spans.
  const stashedMessagesRef = useRef<{
    agent?: Message[];
    chat?: Message[];
    agentModel?: Message[];
    chatModel?: Message[];
  }>({});
  const usageRef = useRef<Usage>({ promptTokens: 0, completionTokens: 0 });
  usageRef.current = totalUsage;
  // The other two halves of the status line's accounting, mirrored for the same reason as
  // `usageRef`: /save reads them from a handler that may be a render behind (#199).
  const lastUsageRef = useRef<Usage | null>(null);
  lastUsageRef.current = lastUsage;
  const estimatedContextRef = useRef<number | null>(null);
  estimatedContextRef.current = estimatedContext;
  const sessionStartedAtRef = useRef(sessionStartedAt);
  sessionStartedAtRef.current = sessionStartedAt;
  const approvalsRef = useRef<Approvals>({ approved: 0, declined: 0 });
  approvalsRef.current = approvals;
  const streamingRef = useRef<string>('');
  const reasoningRef = useRef<string>('');
  const toolRef = useRef<string>('');
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reasoningFlushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const toolFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

  const scheduleFlush = (): void => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setStreaming(streamingRef.current);
    }, 50);
  };

  const scheduleReasoningFlush = (): void => {
    if (reasoningFlushTimerRef.current !== null) return;
    reasoningFlushTimerRef.current = setTimeout(() => {
      reasoningFlushTimerRef.current = null;
      setStreamingReasoning(reasoningRef.current);
    }, 50);
  };

  const scheduleToolFlush = (): void => {
    if (toolFlushTimerRef.current !== null) return;
    toolFlushTimerRef.current = setTimeout(() => {
      toolFlushTimerRef.current = null;
      setStreamingTool(toolRef.current);
    }, 50);
  };

  useEffect(() => {
    (async () => {
      try {
        let cfg = loadConfig();
        // The last session's profile, unless REIKA_MODEL was given at launch (#365). Resolved before
        // the probe and the splash so both describe the model the session actually opens on.
        const profile = startProfile(cfg, loadLastState());
        // Identity detection runs CONCURRENTLY with bootstrap, not before it. Four git
        // subprocesses cost ~28ms warm, which is pure added latency to first paint if serialized.
        // Measured on this repo: 29ms bootstrap + 28ms detect = 56ms serial, 36ms concurrent —
        // so the scrub layer costs ~7ms of startup instead of ~28ms.
        //
        // Both are still awaited here, so the ordering guarantee the scrubber needs is intact:
        // the token set is loaded before any message can be rendered or saved. Detection is
        // best-effort — a failure leaves the scrubber a no-op rather than blocking startup, the
        // same fail-open posture as the other scrub layers.
        // The window probe (#417) rides the same concurrency: a local server answers in
        // milliseconds, and it must land before the budget report below reads the window.
        const [b, probed] = await Promise.all([
          bootstrap(process.cwd(), cfg.repoMapBudget),
          needsLimitsProbe(cfg.profiles[profile])
            ? probeModelLimits(cfg.profiles[profile])
            : Promise.resolve(undefined),
          cfg.anon
            ? detectIdentity(process.cwd())
                .then(setIdentity)
                .catch(() => {})
            : Promise.resolve(),
        ]);
        if (probed) cfg = withProbedLimits(cfg, profile, probed);
        if (probed && !probed.reached) windowRetryRef.current.add(profile);
        setConfig(cfg);
        setActiveProfile(profile);
        setBundle(b);
        // No route out → no web tools this session (#392). Checked once, here, because the tool
        // list is part of the cached prefix; the per-turn latch in the tools covers a drop later.
        const offline = isOffline();
        setTools(defaultTools(cfg, { offline }));
        setChatToolsList(chatTools(cfg, { offline }));
        // Startup only: a later /model switch reports its own window in /stats.
        const runtime = resolveProfile(cfg, profile);
        setHeaderItems(prev => [
          ...prev,
          {
            kind: 'splash',
            model: runtime.model,
            cwd: b.cwd,
            version: VERSION,
            subagent:
              cfg.subagentModel && cfg.subagentModel !== runtime.model
                ? cfg.subagentModel
                : undefined,
          },
        ]);
        // Opening somewhere other than where the env alone would put the session is a fact the
        // user has to see — a plan-mode start answers a task with a plan, not edits — so it gets a
        // persistent line, not just the status-bar tag.
        const resumed = [
          ...(modeRef.current !== resolveDefaultMode() ? [`${modeRef.current} mode`] : []),
          ...(profile !== 'default' ? [`profile '${profile}' (${runtime.model})`] : []),
        ];
        if (resumed.length > 0) {
          setMessages(prev => [
            ...prev,
            { role: 'system', content: `Resumed ${resumed.join(' and ')} from the last session.` },
          ]);
        }
        // The window/reserve arithmetic decides how much room reads and history get, and a
        // configuration that leaves too little degrades silently — reads truncated every round,
        // the model re-reading the same file (#262). Report the numbers to the log always, and
        // say so in the scrollback when they fall under the floor.
        debugLog(formatBudget(b, runtime));
        const limitsNotice = probed && probedLimitsNotice(probed);
        if (limitsNotice) {
          setMessages(prev => [...prev, { role: 'system', content: limitsNotice }]);
        }
        const warn = budgetWarning(b, runtime);
        if (warn) setMessages(prev => [...prev, { role: 'system', content: warn, tone: 'warn' }]);
        if (offline) {
          setMessages(prev => [
            ...prev,
            {
              role: 'system',
              content:
                'No network — search and fetch_url tools are off for this session. Restart Reika once you are back online to get them back.',
              tone: 'warn',
            },
          ]);
        }
        setStatus('idle');
      } catch (e) {
        setError((e as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    },
    [],
  );

  // Every route to a new mode or profile (slash command, Shift+Tab, /implement, /clear, the
  // picker) lands here, so the saved state can't miss one. The profile waits for the config, since
  // until then 'default' is only the initial state and would overwrite the value about to be
  // restored.
  useEffect(() => {
    const persisted = persistableMode(mode);
    if (persisted) saveLastState({ mode: persisted });
  }, [mode]);
  const configLoaded = config !== null;
  useEffect(() => {
    if (configLoaded) saveLastState({ profile: activeProfile });
  }, [configLoaded, activeProfile]);

  useEffect(() => {
    if (!exitRequested) return;
    // Defer one tick so the just-pushed summary message renders before we unmount.
    const id = setTimeout(() => exit(), 0);
    return () => clearTimeout(id);
  }, [exitRequested, exit]);

  useEffect(() => {
    if (status !== 'busy') {
      setElapsed(0);
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
  }, [status]);

  useEffect(() => {
    // Pause the elapsed-time interval while an approval is pending — every tick
    // re-renders the live region, which trips the xterm.js scroll-jump bug.
    if (status !== 'busy' || pending !== null || question !== null) return;
    const id = setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [status, pending, question]);

  // Branch↔PR badge. The poll only shells out to git (cheap, local); the `gh` lookup behind
  // it is cached per branch, so a branch switch made in another terminal shows up within a
  // tick without hammering the network. State only changes when the number does, so the
  // steady-state tick costs no re-render.
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const next = await resolvePr(process.cwd(), Date.now());
      if (!cancelled) setPr(next);
    };
    void check();
    const id = setInterval(() => void check(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Switch the active profile and record it in scrollback — shared by
  // `/model <name>` and the interactive picker's enter. The optional echo is
  // the command line that triggered it (the picker already echoed on open).
  // `cfg` overrides the config state for the same-render case where the caller just
  // registered an ad-hoc profile via setConfig and the closure hasn't caught up.
  const applyModelSwitch = (target: string, echo?: Message, cfg: Config | null = config): void => {
    if (!cfg) return;
    const next = cfg.profiles[target];
    if (!next) return;
    const kind = cfg.models.map(m => m.toLowerCase()).includes(target) ? 'model' : 'profile';
    setActiveProfile(target);
    // The tok/s chip describes the model that produced it (#204) — left standing, the previous
    // model's rate reads as the new one's until a round here measures one, which on a slow local
    // endpoint is minutes of a number about the wrong engine.
    decodeRateRef.current = undefined;
    setDecodeRate(undefined);
    // A profile with no window asks the endpoint for its model's (#417). Not awaited: the switch
    // is instant, and a turn submitted before the answer lands runs without a window, as it
    // would have anyway.
    if (needsLimitsProbe(next)) {
      void probeModelLimits(next).then(probe => {
        if (!probe.reached) windowRetryRef.current.add(target);
        const notice = probedLimitsNotice(probe);
        if (!notice) return;
        setConfig(prev => (prev ? withProbedLimits(prev, target, probe) : prev));
        setMessages(prev => [...prev, { role: 'system', content: notice }]);
      });
    }
    setMessages(prev => [
      ...prev,
      ...(echo ? [echo] : []),
      {
        role: 'system' as const,
        content: next.adhoc
          ? `Switched to model '${next.model}' — not in your config; using it anyway on ${next.baseURL}`
          : `Switched to ${kind} '${target}' (${next.model})`,
      },
    ]);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const hadPending = pendingRef.current !== null;
      // Interrupt anything in flight: decline a pending approval, drop an unanswered question,
      // abort a turn.
      if (hadPending) {
        pendingRef.current!.resolve(false);
        setPending(null);
      }
      if (questionRef.current) {
        questionRef.current.resolve(null);
        setQuestion(null);
        setQuestionTyping(null);
      }
      // An open confirm closes first, like the /model picker, and the turn (if one is running)
      // keeps going: the dialog is about the prompt being submitted, not the turn.
      if (!hadPending && !questionRef.current && confirmRef.current) {
        confirmRef.current.resolve('abort');
        setConfirm(null);
        return;
      }
      if (statusRef.current === 'busy' && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      if (hadPending) return;
      // An open /model picker closes first, like esc.
      if (modelSelectRef.current) {
        setModelSelect(null);
        return;
      }
      // Idle. A non-empty input clears first — catches the common accidental tap.
      if (inputValueRef.current.length > 0) {
        setInputValue('');
        setSuggestionState(null);
        disarmExit();
        return;
      }
      // Empty input: require a second Ctrl+C within the window to actually exit.
      if (exitArmedRef.current) {
        disarmExit();
        requestExit();
        return;
      }
      setExitArmed(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        setExitArmed(false);
      }, 1500);
      return;
    }
    if (pendingRef.current) {
      if (key.upArrow) {
        setApprovalSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setApprovalSelected(i => Math.min(2, i + 1));
        return;
      }
      if (key.return) {
        const sel = approvalSelectedRef.current;
        const resolve = pendingRef.current.resolve;
        setPending(null);
        if (sel === 0) resolve(true);
        else if (sel === 1) resolve(false);
        else {
          setSessionAutoApprove(true);
          resolve(true);
        }
        return;
      }
      if (input === 'y' || input === 'Y') {
        pendingRef.current.resolve(true);
        setPending(null);
      } else if (input === 'n' || input === 'N') {
        pendingRef.current.resolve(false);
        setPending(null);
      }
      return;
    }
    const q = questionRef.current;
    if (q) {
      // Typing the answer: Input owns the keyboard. Nothing here may consume the keystroke, or the
      // answer loses characters to the dialog that asked for it.
      if (questionTypingRef.current) return;
      // Rows are the options plus the always-last "type your own" row.
      const last = q.request.options.length;
      if (key.upArrow) {
        setQuestionSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setQuestionSelected(i => Math.min(last, i + 1));
        return;
      }
      // A digit jumps the cursor to that numbered row (the type-your-own row is `last + 1`). It
      // moves, never submits: Enter stays the one key that answers.
      if (/^[1-9]$/.test(input) && Number(input) - 1 <= last) {
        setQuestionSelected(Number(input) - 1);
        return;
      }
      // Tab on an option: take it, but add a note in your own words. The model gets both.
      if (key.tab && questionSelectedRef.current < last) {
        const forIndex = questionSelectedRef.current;
        queueMicrotask(() => setQuestionTyping({ forIndex }));
        return;
      }
      if (key.return) {
        const sel = questionSelectedRef.current;
        if (sel === last) {
          // Deferred a microtask: this same keypress is dispatched to every useInput handler with
          // re-renders in between, so enabling Input synchronously hands it the very Enter that
          // opened it and submits an empty answer.
          queueMicrotask(() => setQuestionTyping({}));
          return;
        }
        const chosen = q.request.options[sel];
        setQuestion(null);
        setQuestionTyping(null);
        q.resolve({ text: chosen.label, index: sel });
        return;
      }
      // No escape-to-skip, deliberately, and none in the typing branch above either. An arrow key
      // is ESC `[` A/B, and when those bytes arrive in separate chunks — which a pty under load
      // does, observed while driving this dialog — Ink hands the handler a bare `key.escape`
      // first. On a picker that costs a reopened list; here it would silently answer on the
      // user's behalf and tell the model to proceed without them. Approval binds no escape for
      // the same reason: ctrl-c is the one way out of a modal that decides something.
      // Modal while the list is up: the input is disabled, so no other key has anywhere to go.
      return;
    }
    const cf = confirmRef.current;
    if (cf) {
      // Digits and y/n only move the cursor, as in the question dialog: Enter is the one key that
      // answers, and y lands on the accepting row — the one Approval-trained fingers expect first.
      if (key.upArrow) {
        setConfirmSelected(i => Math.max(CONFIRM_DECLINE, i - 1));
      } else if (key.downArrow) {
        setConfirmSelected(i => Math.min(CONFIRM_ACCEPT, i + 1));
      } else if (input === '1' || input === 'n' || input === 'N') {
        setConfirmSelected(CONFIRM_DECLINE);
      } else if (input === '2' || input === 'y' || input === 'Y') {
        setConfirmSelected(CONFIRM_ACCEPT);
      } else if (key.return) {
        const accept = confirmSelectedRef.current === CONFIRM_ACCEPT;
        setConfirm(null);
        cf.resolve(accept);
      }
      // No escape, for the reason Approval and Question bind none: a split arrow sequence arrives
      // as a bare escape on a loaded pty. Modal: the input is disabled, so nothing else has
      // anywhere to go.
      return;
    }
    const ms = modelSelectRef.current;
    if (ms) {
      if (key.upArrow) {
        setModelSelected(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setModelSelected(i => Math.min(ms.length - 1, i + 1));
      } else if (key.return) {
        const sel = ms[modelSelectedRef.current];
        setModelSelect(null);
        if (sel) applyModelSwitch(sel.name);
      } else if (key.escape) {
        setModelSelect(null);
      }
      // Modal: the input is disabled while the picker is open, so no other key
      // has anywhere to go.
      return;
    }
    // Shift+Tab cycles agent → plan → minimal → vibe → chat → shell. Only while idle — mode picks the
    // in-flight turn's tools and prompt, the same reason /plan et al. refuse while busy; a
    // keystroke shouldn't spam that refusal into scrollback, so it just no-ops.
    if (key.tab && key.shift) {
      if (statusRef.current === 'idle') transitionMode(nextMode(modeRef.current), []);
      return;
    }
    const sug = suggestionStateRef.current;
    if (sug && sug.items.length > 0) {
      if (key.upArrow) {
        setSuggestionSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionSelected(i => Math.min(sug.items.length - 1, i + 1));
        return;
      }
      if (key.tab || key.return) {
        const sel = sug.items[suggestionSelectedRef.current];
        if (sel) {
          const next = acceptSuggestion(inputValueRef.current, sel, sug.partial);
          // Enter on an already-complete buffer means submit, not re-accept —
          // otherwise every fully-typed command would cost a second Enter.
          // Input's Return handler no-ops while suggesting, so submit from here.
          // Busy is not a dead key here either (#226): onSubmit queues, or runs /save on the
          // spot, exactly as it does for a submit that came through Input. An approval dialog
          // never reaches this branch — the pending handler above owns the keyboard then.
          if (key.return && next === inputValueRef.current) {
            void onSubmit(next);
            return;
          }
          setInputValue(next);
          setSuggestionState(null);
        }
        return;
      }
      if (key.escape) {
        setSuggestionState(null);
        return;
      }
    }
  });

  const requestExit = (): void => {
    if (hasActivity(messagesRef.current)) {
      const summary = buildSummary(
        messagesRef.current,
        usageRef.current,
        sessionStartedAtRef.current,
        approvalsRef.current,
      );
      setMessages(prev => [...prev, { role: 'system', content: summary }]);
    }
    setExitRequested(true);
  };

  const onInputChange = (value: string): void => {
    // First keystroke of a new prompt (read against the pre-render ref) while idle:
    // speculatively warm the server's KV cache with the prefix the submit will send. The edge is
    // the buffer becoming a prompt, not merely becoming non-empty — a leading '/' or '@', or a
    // marker standing in for a paste, isn't one (issue #202, see isWarmEdge). Shell mode never
    // warms. Repeat edges on the same prefix dedupe inside the warmer; strict no-op unless
    // REIKA_WARM=1.
    const edge = isWarmEdge(inputValueRef.current, value);
    setInputValue(value);
    if (!bundle) {
      setSuggestionState(null);
      return;
    }
    if (edge && config && statusRef.current === 'idle' && modeRef.current !== 'shell') {
      const m = modeRef.current;
      warmerRef.current.onEdge({
        // The model history, so the warm reproduces the prefix round 0 will actually send —
        // including any span already folded by a previous turn's compaction.
        history: modelHistoryRef.current,
        bundle,
        config: resolveProfile(config, activeProfileRef.current),
        // Same mapping as submitToModel below, through the same helpers so the two cannot drift —
        // a warm that builds a different prefix than the submit is a guaranteed cache miss.
        // Vibe's first internal turn is a plan turn, so it warms the plan prefix.
        tools: turnTools(m, {
          agent: tools,
          plan: planTools(),
          chat: chatToolsList,
          minimal: minimalTools(),
        }),
        promptMode: turnPromptMode(m),
        minimalPrompt: isMinimalPrompt(m),
        calibration: calibrationRef.current,
      });
    }
    const next = computeSuggestions(
      value,
      bundle.fileIndex,
      bundle.skills,
      config ? buildModelTargets(config, activeProfileRef.current) : [],
    );
    setSuggestionState(next);
    setSuggestionSelected(0);
  };

  const requestApproval = (req: ApprovalRequest): Promise<boolean> => {
    // 'safe' (env or default) and the session toggle are the same policy (approval.ts, shared
    // with the headless runner): ordinary actions auto-run, a flagged dangerous command still
    // falls through to the prompt. 'bypass' never reaches here — requestApproval is undefined in
    // that mode (see runTurn wiring below).
    const policy = effectiveAutoApprove(config, sessionAutoApproveRef.current);
    if (autoApproves(policy, req)) {
      setApprovals(a => ({ ...a, approved: a.approved + 1 }));
      return Promise.resolve(true);
    }
    setApprovalSelected(0);
    return new Promise(resolve => {
      const wrappedResolve = (allow: boolean): void => {
        setApprovals(a =>
          allow ? { ...a, approved: a.approved + 1 } : { ...a, declined: a.declined + 1 },
        );
        resolve(allow);
      };
      setPending({ request: req, resolve: wrappedResolve });
    });
  };

  const requestQuestion = (req: QuestionRequest): Promise<QuestionAnswer | null> => {
    setQuestionSelected(0);
    setQuestionTyping(null);
    return new Promise(resolve => setQuestion({ request: req, resolve }));
  };

  // The mode change itself, shared by the slash commands and Shift+Tab cycling. `trailing`
  // lands after any restored history (the command echo + banner for /chat et al., nothing
  // for cycling — the status-bar mode tag is that path's feedback).
  const transitionMode = (next: Mode, trailing: Message[]): void => {
    const currentIsChat = modeRef.current === 'chat';
    const nextIsChat = next === 'chat';
    if (currentIsChat !== nextIsChat) {
      // Crossing the chat boundary — save current array, restore the other side's stash
      const stash = stashedMessagesRef.current;
      if (currentIsChat) {
        stash.chat = messagesRef.current;
        stash.chatModel = modelHistoryRef.current;
      } else {
        stash.agent = messagesRef.current;
        stash.agentModel = modelHistoryRef.current;
      }
      const restored = (nextIsChat ? stash.chat : stash.agent) ?? [];
      setMessages([...restored, ...trailing]);
      // The trailing banner/echo are UI-only (system + meta), so the model history restores bare.
      modelHistoryRef.current = (nextIsChat ? stash.chatModel : stash.agentModel) ?? [];
    } else if (trailing.length > 0) {
      setMessages(prev => [...prev, ...trailing]);
    }
    setMode(next);
  };

  const switchMode = (next: Mode, banner: string, echo: Message): void => {
    if (next === mode) {
      setMessages(prev => [...prev, echo, { role: 'system', content: `Already in ${next} mode.` }]);
      return;
    }
    if (statusRef.current === 'busy') {
      setMessages(prev => [
        ...prev,
        echo,
        { role: 'system', content: 'Cannot switch modes while busy. Wait or ctrl-c to abort.' },
      ]);
      return;
    }
    transitionMode(next, [echo, { role: 'system', content: banner }]);
  };

  const handleCommand = async (raw: string): Promise<void> => {
    const rest = raw.slice(1);
    const space = rest.indexOf(' ');
    const name = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
    const args = space === -1 ? '' : rest.slice(space + 1);
    // `meta` keeps this command echo in the scrollback but out of the model-facing history.
    const echo: Message = { role: 'user', content: raw, meta: true };

    if (name === 'clear' || name === 'new') {
      // Seed the wiped scrollback with a persistent receipt (echo + notice) rather
      // than leaving it empty — a bare screen after /new is indistinguishable from a
      // fresh launch, so the user can't tell the reset actually happened. Both sides
      // of the chat/agent stash go too: a stashed conversation resurfacing on the
      // next mode switch would make the "new session" a lie.
      setMessages([
        echo,
        { role: 'system', content: 'New session — conversation, tokens, and mode reset.' },
      ]);
      stashedMessagesRef.current = {};
      modelHistoryRef.current = [];
      // With the messages and stashes gone, no payloadId can reach the store anymore.
      payloads.clear();
      setPlanSteps(null);
      setTotalUsage({ promptTokens: 0, completionTokens: 0 });
      setLastUsage(null);
      setEstimatedContext(null);
      setShrink({ sheds: 0, folds: 0 });
      shrinkRef.current = { sheds: 0, folds: 0 };
      shrinkEventsRef.current = [];
      calibrationRef.current = 1;
      // /clear also drops back to the default profile, which may be a different model on different
      // hardware — a rate learned under the old one would misprice every round until it re-learns.
      prefillRateRef.current = undefined;
      // Same for decode throughput (#204): the chip describes the model that produced it, and
      // /clear drops back to the default profile, which may be a different one on different
      // hardware. The chip itself goes with the token counts it sits next to.
      decodeRateRef.current = undefined;
      setDecodeRate(undefined);
      prefixTraceRef.current = new PrefixTrace();
      setApprovals({ approved: 0, declined: 0 });
      setSessionStartedAt(Date.now());
      setSessionAutoApprove(null);
      setMode('agent');
      setActiveProfile('default');
      return;
    }
    if (name === 'exit' || name === 'quit') {
      requestExit();
      return;
    }
    if (name === 'stats') {
      const content = hasActivity(messagesRef.current)
        ? buildSummary(
            messagesRef.current,
            usageRef.current,
            sessionStartedAtRef.current,
            approvalsRef.current,
          )
        : 'No activity yet.';
      setMessages(prev => [...prev, echo, { role: 'system', content }]);
      return;
    }
    if (
      name === 'shell' ||
      name === 'agent' ||
      name === 'chat' ||
      name === 'plan' ||
      name === 'vibe' ||
      name === 'minimal'
    ) {
      const banner =
        name === 'shell'
          ? 'Shell mode. Commands run directly in cwd. /agent to return.'
          : name === 'chat'
            ? 'Chat mode. Filesystem and shell tools disabled. Conversation isolated from agent. /agent to return.'
            : name === 'plan'
              ? 'Plan mode — read-only exploration; will end with a written plan. /agent to execute it.'
              : name === 'vibe'
                ? 'Vibe mode — each prompt is planned first (read-only), then the plan is implemented automatically. Approvals apply as usual. /agent to return.'
                : name === 'minimal'
                  ? 'Minimal mode — shell only, and no repo map, project summary, or AGENTS.md in the prompt. The model works from what commands show it. /agent to return.'
                  : 'Agent mode.';
      switchMode(name, banner, echo);
      return;
    }
    if (name === 'implement') {
      // Shortcut for the plan→agent handoff: flip to agent mode and submit "execute the plan
      // above" so the user doesn't have to /agent then hand-write the prompt. The plan sits in
      // `messages` from prior renders, so it's in the history slice submitToModel sends; the loop
      // folds the exploration into a digest automatically (REIKA_PLAN_HANDOFF, default on).
      if (mode === 'shell' || mode === 'chat') {
        setMessages(prev => [
          ...prev,
          echo,
          {
            role: 'system',
            content: `/implement isn't available in ${mode} mode — use it from plan mode (or agent mode) to execute a plan.`,
          },
        ]);
        return;
      }
      if (mode === 'plan') {
        setMode('agent');
        setMessages(prev => [
          ...prev,
          { role: 'system', content: 'Agent mode — implementing the plan above.' },
        ]);
      }
      // The user bubble renders as `/implement` (displayOverride) while the model receives the
      // built prompt; the override forces this turn's tools + promptMode regardless of the
      // not-yet-flushed mode state. 'agent' for every mode but minimal, which stays itself —
      // handing a minimal session the full tool list and the whole repo map for one turn would
      // undo the only thing the mode does, and silently.
      await submitToModel(
        buildImplementPrompt(args),
        raw,
        mode === 'minimal' ? 'minimal' : 'agent',
      );
      return;
    }
    if (name === 'cd') {
      const target = args.trim();
      if (!target) {
        setMessages(prev => [...prev, echo, { role: 'system', content: 'Usage: /cd <path>' }]);
        return;
      }
      if (!bundle || !config) return;
      const expanded = expandHome(target);
      const newCwd = isAbsolute(expanded) ? expanded : resolve(bundle.cwd, expanded);
      setStatus('busy');
      setMessages(prev => [...prev, echo, { role: 'system', content: `Re-indexing ${newCwd}…` }]);
      try {
        const newBundle = await bootstrap(newCwd, config.repoMapBudget);
        setBundle(newBundle);
        setMessages(prev => [...prev, { role: 'system', content: `cwd is now ${newCwd}` }]);
      } catch (e) {
        setMessages(prev => [
          ...prev,
          { role: 'system', content: `cd failed: ${(e as Error).message}` },
        ]);
      } finally {
        setStatus('idle');
      }
      return;
    }

    if (name === 'save') {
      if (!config || !bundle) return;
      const raw = args.trim().toLowerCase() === '--raw';
      // Mid-turn (#226): the loop hands each finished round to the scrollback as it lands, so a
      // save now holds everything up to the last completed round. The round still streaming is
      // not a message yet and is not in it — the receipt says so, so a reader of the transcript
      // isn't left wondering why it ends without a reply.
      const midTurn = statusRef.current === 'busy';
      const msgs = messagesRef.current;
      if (msgs.length === 0) {
        setMessages(prev => [...prev, echo, { role: 'system', content: 'Nothing to save yet.' }]);
        return;
      }
      // Use the active profile's model/base so the saved meta reflects what was actually running,
      // not the default. Stamp savedAt here (the serializer is pure and takes no clock).
      const profile = config.profiles[activeProfileRef.current] ?? config.profiles.default;
      // Everything the status line shows, frozen at save time (#199). Computed exactly as the
      // status bar computes it — same turn count, same last-call-else-estimate context — so the
      // header and a screenshot of the footer can never disagree.
      const last = lastUsageRef.current;
      const totals = usageRef.current;
      const window = profile.contextWindow ?? config.contextWindow;
      const usable = window
        ? Math.round(compactThreshold(window, profile.minGenTokens))
        : undefined;
      const usage: TranscriptUsage = {
        turns: msgs.filter(m => m.role === 'assistant').length,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        ...(totals.cachedTokens != null ? { cachedTokens: totals.cachedTokens } : {}),
        contextTokens: last?.promptTokens ?? estimatedContextRef.current,
        // No call has landed yet, so the context size above is the pre-send estimate.
        ...(last?.promptTokens == null ? { contextEstimated: true } : {}),
        ...(window ? { contextWindow: window } : {}),
        ...(usable ? { contextUsable: usable } : {}),
        ...(last?.cachedTokens != null ? { lastCachedTokens: last.cachedTokens } : {}),
        ...(shrinkRef.current.sheds > 0 || shrinkRef.current.folds > 0
          ? { ...shrinkRef.current, shrinkEvents: shrinkEventsRef.current }
          : {}),
      };
      try {
        const { jsonlPath, txtPath } = await saveTranscript(
          join(homedir(), '.config', 'reika', 'history'),
          msgs,
          {
            version: TRANSCRIPT_VERSION,
            savedAt: new Date().toISOString(),
            model: profile.model,
            baseURL: profile.baseURL,
            cwd: bundle.cwd,
            messageCount: msgs.length,
            mode: modeRef.current,
            usage,
            ...(midTurn ? { midTurn: true as const } : {}),
          },
          { redact: !raw },
        );
        setMessages(prev => [
          ...prev,
          echo,
          {
            role: 'system',
            content: `saved ${msgs.length} messages${raw ? ' (raw, unredacted)' : ''}${midTurn ? ' — mid-turn, up to the last completed round; the turn continues' : ''} → ${jsonlPath}\n(+ ${txtPath})`,
          },
        ]);
      } catch (e) {
        setMessages(prev => [
          ...prev,
          echo,
          { role: 'error', content: `save failed: ${(e as Error).message}` },
        ]);
      }
      return;
    }

    let response: string;
    switch (name) {
      case 'help':
        response = [
          'Commands:',
          '  /help              show this list',
          '  /new, /clear       reset conversation, tokens, mode',
          '  /cd <path>         change cwd (re-indexes repo map)',
          '  /shell             enter shell mode (raw bash, no model)',
          '  /chat              enter chat mode (no filesystem/shell tools; isolated)',
          '  /vibe              enter vibe mode (every prompt plans first, then implements)',
          '  /agent             return to agent mode',
          '  /implement         switch to agent mode and execute the plan above',
          '  /model [name]      pick a model/profile (interactive without a name; a name not in your config switches ad-hoc)',
          '  /anon              show/toggle anonymized display (on|off)',
          '  /cwd               show working directory',
          '  /tokens            show token usage this session',
          '  /stats             show full session summary',
          '  /save              save the full conversation to history, even mid-turn (--raw skips redaction)',
          '  /exit, /quit       exit reika (prints summary)',
          '  @<path>            in agent mode, inline a file as context',
          '  ctrl-v             paste an image; its text is read out and attached (macOS/Windows)',
          '  shift+tab          cycle mode (agent → plan → minimal → vibe → chat → shell)',
        ].join('\n');
        break;
      case 'model': {
        if (!config) {
          response = 'config not loaded';
          break;
        }
        const target = args.trim().toLowerCase();
        if (target) {
          if (!config.profiles[target]) {
            // A config model can lack its own profile only in the single-model case
            // (loadProfiles registers auto-profiles from two models up); its switch
            // target is 'default', same as buildModelTargets maps it.
            if (config.models.some(m => m.toLowerCase() === target)) {
              applyModelSwitch('default', echo);
              return;
            }
            // A name not in the config still switches (#96): testing a model that's
            // up on the current server shouldn't require touching .env. Register it
            // as an ad-hoc profile inheriting the active profile's connection
            // settings — being a real profile means the picker, completion, and
            // resolveProfile all see it; the adhoc flag keeps the UI honest that
            // it's off-config. Casing as typed: the key lowercases like every
            // profile key, but the server gets the model string verbatim.
            const inherit = config.profiles[activeProfileRef.current] ?? config.profiles.default;
            const withAdhoc = {
              ...config,
              profiles: {
                ...config.profiles,
                [target]: inheritProfile(inherit, args.trim()),
              },
            };
            setConfig(withAdhoc);
            applyModelSwitch(target, echo, withAdhoc);
            return;
          }
          applyModelSwitch(target, echo);
          return;
        }
        // Bare /model opens the interactive picker, cursor parked on the
        // active entry. The echo lands now so the command shows in scrollback
        // even if the picker is dismissed.
        const targets = buildModelTargets(config, activeProfile);
        setMessages(prev => [...prev, echo]);
        // Deferred past the current keypress dispatch: Ink hands the same
        // Enter to every useInput handler, and the submit re-renders in
        // between — opening synchronously would let the picker's own handler
        // see that Enter and instantly select the first entry.
        queueMicrotask(() => {
          setModelSelect(targets);
          setModelSelected(
            Math.max(
              0,
              targets.findIndex(t => t.active),
            ),
          );
        });
        return;
      }
      case 'approvals': {
        const envOn = config ? autoApproveForced(config) : false;
        const target = args.trim().toLowerCase();
        if (target === 'on' || target === 'off') {
          if (envOn) {
            response = `auto-approve is forced to '${config?.autoApprove}' by REIKA_AUTO_APPROVE; session toggle has no effect.`;
            break;
          }
          setSessionAutoApprove(target === 'on');
          response = `Session auto-approve: ${target}`;
          break;
        }
        if (target) {
          response = `Unknown argument: ${target}. Use /approvals on or /approvals off.`;
          break;
        }
        // Session toggle grants 'safe' behavior; env can force 'safe' or 'bypass'; unset is 'safe'.
        const effectiveMode = effectiveAutoApprove(config, sessionAutoApprove);
        const source = envOn
          ? `REIKA_AUTO_APPROVE=${config?.autoApprove} (env)`
          : sessionAutoApprove !== null
            ? 'session toggle'
            : config?.autoApproveExplicit
              ? 'REIKA_AUTO_APPROVE=off (env)'
              : 'default (REIKA_AUTO_APPROVE unset)';
        const desc =
          effectiveMode === 'bypass'
            ? 'bypass — everything runs without confirmation, including dangerous commands'
            : effectiveMode === 'safe'
              ? 'safe — ordinary actions auto-run; dangerous commands still prompt'
              : 'off — every action asks first';
        response = [
          `auto-approve: ${effectiveMode}`,
          `  ${desc}`,
          `  source: ${source}`,
          '',
          envOn
            ? 'env REIKA_AUTO_APPROVE forces this; session toggle is shadowed'
            : 'toggle with /approvals on or /approvals off',
        ].join('\n');
        break;
      }
      // Always available, NOT gated on REIKA_ANON — gating it there would make the toggle useless
      // for the case it exists for ("I'm about to record and didn't set the env var"): you'd need
      // anonymization already on to reach the command that turns it on. The env var sets the
      // STARTING state; this switches it at any point. Detection is lazy, so leaving it alone
      // costs nothing.
      case 'anon': {
        const arg = args.trim().toLowerCase();
        const want = arg === 'on' ? true : arg === 'off' ? false : !isAnon();
        if (!want) {
          clearIdentity();
          response = 'anonymize: off — names, emails and account slugs render verbatim again';
          break;
        }
        const id = await enableAnon(bundle?.cwd ?? process.cwd());
        const found = id.names.length + id.emails.length;
        response = [
          'anonymize: on',
          found === 0
            ? '  no identity found (no git config, no remote) — nothing to substitute'
            : `  substituting ${id.names.length} name(s) → <user>, ${id.emails.length} email(s) → <email>`,
          // The honest limitation: scrollback is <Static>, so committed messages never re-render.
          // /save re-serializes from `messages`, so it IS retroactive. Saying so here beats
          // burying it in docs and letting the untouched lines above read as a bug.
          '  applies to new output and to /save; run /clear to scrub what is above',
        ].join('\n');
        break;
      }
      case 'cwd':
        response = bundle?.cwd ?? '(unknown)';
        break;
      case 'tokens':
        response = `prompt:     ${totalUsage.promptTokens}\ncompletion: ${totalUsage.completionTokens}`;
        break;
      case 'skills': {
        const list = bundle?.skills ?? [];
        if (list.length === 0) {
          response =
            'No skills loaded. Drop *.md files in ~/.config/reika/skills/ or <cwd>/.reika/skills/.';
        } else {
          response = [
            'Available skills (invoke as /<name>):',
            ...list.map(
              s =>
                `  /${s.name.padEnd(16)} ${s.description} ${s.source === 'project' ? '(project)' : ''}`,
            ),
          ].join('\n');
        }
        break;
      }
      default: {
        const skill = bundle?.skills.find(s => s.name === name);
        if (skill) {
          // `raw` stays the display, so the bubble shows the marker while the model gets the text.
          const extra = expandPastes(args.trim(), pastedTextsRef.current);
          const prompt = extra ? `${skill.body}\n\n${extra}` : skill.body;
          pendingSkillRef.current = skill.name;
          // Same receipt shape as auto-routing: the bubble echoes what was typed, and only
          // this line says the body is what the model got (#398).
          pendingNoticesRef.current.push({
            role: 'system',
            content: `Skill /${skill.name} applied — its body was sent as this prompt${extra ? ', with your text after it' : ''}.`,
            tone: 'info',
          });
          // No `echo` here: unlike the UI-only commands above, a skill runs a real turn, and
          // runTurn emits its own user message rendered via `raw` (displayOverride) — the user
          // bubble reads `/issue 14` while the model receives the skill body. Pre-appending
          // would double it. Same pattern as /implement.
          // Skills follow the active mode's prompt handling, so in vibe mode they
          // plan-then-implement like any other prompt.
          if (modeRef.current === 'vibe') {
            await runVibeTurn(prompt, raw);
          } else {
            await submitToModel(prompt, raw);
          }
          return;
        }
        response = `Unknown command: /${name}. Try /help.`;
      }
    }
    setMessages(prev => [...prev, echo, { role: 'system', content: response }]);
  };

  const runShell = async (command: string): Promise<void> => {
    if (!bundle) return;
    // Shell mode is "raw bash, no model" — the command echo stays in the scrollback but is
    // kept out of the model history (its output, the `shell` message below, is UI-only too).
    const echo: Message = { role: 'user', content: command, meta: true };
    setMessages(prev => [...prev, echo]);
    setStatus('busy');
    toolRef.current = '';
    setStreamingTool('');
    // Same bounds and the same ctrl-c as a model-run command: the shell is the user's, but the UI
    // is blocked on it just the same.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await execStream(command, {
        cwd: bundle.cwd,
        bashTimeoutMs: config?.bashTimeoutMs,
        bashIdleMs: config?.bashIdleMs,
        signal: controller.signal,
        onProgress: chunk => {
          toolRef.current += chunk;
          scheduleToolFlush();
        },
      });
      const shellMsg: Message = {
        role: 'shell',
        command,
        output: result.payload ?? '',
      };
      setMessages(prev => [...prev, shellMsg]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', content: (e as Error).message }]);
    } finally {
      if (toolFlushTimerRef.current !== null) {
        clearTimeout(toolFlushTimerRef.current);
        toolFlushTimerRef.current = null;
      }
      toolRef.current = '';
      setStreamingTool('');
      abortRef.current = null;
      setStatus('idle');
    }
  };

  // Ctrl+V. Outcomes are all persistent scrollback lines rather than spinner states: the user
  // pressed a key expecting an attachment, and "nothing happened" has to be distinguishable
  // from "attached, and here's how much text came out".
  const onPasteImage = async (): Promise<void> => {
    const notice = (content: string, tone: 'info' | 'warn'): void => {
      setMessages(prev => [...prev, { role: 'system', content, tone }]);
    };
    if (!clipboardImageSupported()) {
      notice('Image paste needs system OCR — macOS and Windows only.', 'warn');
      return;
    }
    // Shell mode submits the buffer to bash, which would try to run `[Image 1]` as a command —
    // there's no model turn for the block to ride along with.
    if (modeRef.current === 'shell') {
      notice("Can't attach an image in shell mode.", 'warn');
      return;
    }
    // A second ctrl-v mid-paste would race a duplicate marker in. Ref, not state: the handler
    // closes over its render's state, so a fast double-press would read a stale `false`.
    if (pasteBusyRef.current) return;
    pasteBusyRef.current = true;
    try {
      await runPaste(notice);
    } finally {
      pasteBusyRef.current = false;
      setPasting(null);
    }
  };

  // The two stages are ~330ms (the pasteboard rendering PNG data) and ~205ms (the recognizer),
  // neither removable — so they're narrated instead. Naming the current stage beats one generic
  // spinner: it tells the user whether the wait is the clipboard or the OCR.
  const runPaste = async (notice: (content: string, tone: 'info' | 'warn') => void) => {
    setPasting('Reading image from clipboard');
    const bytes = await readClipboardImage();
    if (!bytes) {
      notice('No image on the clipboard.', 'warn');
      return;
    }
    setPasting('Extracting text');
    const result = await systemOcr(config?.ocrLangs)(bytes);
    if (!result.ok) {
      notice(
        result.reason === 'unavailable'
          ? 'Image paste needs system OCR — macOS and Windows only.'
          : result.reason === 'no-text'
            ? 'No text found in the pasted image.'
            : `Couldn't read the pasted image: ${result.detail ?? 'OCR failed'}`,
        'warn',
      );
      return;
    }
    const marker = nextImageMarker(imageAttachmentsRef.current);
    imageAttachmentsRef.current = [
      ...imageAttachmentsRef.current,
      { marker, text: result.text, source: 'clipboard' },
    ];
    // Appended rather than inserted at the cursor: the Input owns cursor state and snaps to the
    // end on any external value change, so a mid-buffer insert would move the caret anyway.
    setInputValue(prev => (prev === '' || prev.endsWith(' ') ? prev : prev + ' ') + marker + ' ');
    notice(
      `Attached ${marker} — ${result.text.length} chars read from the clipboard image.`,
      'info',
    );
  };

  // A paste the Input refuses to hold verbatim: park the text and hand back the marker that
  // takes its place in the buffer. No scrollback receipt — unlike a clipboard image, the marker
  // itself is visible in the box and rides into the user bubble, so nothing is silent.
  const onPasteText = (text: string): string => {
    const { pastes, marker } = rememberPaste(pastedTextsRef.current, text);
    pastedTextsRef.current = pastes;
    return marker;
  };

  // The keypress handler is synchronous, so nothing awaits the above. Swallow into an error
  // line rather than letting a rejection escape as an unhandled promise and kill the TUI.
  const onPasteImageSafely = (): void => {
    void onPasteImage().catch((e: unknown) => {
      setMessages(prev => [
        ...prev,
        { role: 'error', content: `Image paste failed: ${(e as Error).message}` },
      ]);
    });
  };

  // Open the confirm dialog and wait for its answer. Deferred past the current keypress dispatch:
  // Ink hands the Enter that submitted to every useInput handler, and opening synchronously would
  // let the dialog's own handler see it and answer "send as typed" on the spot.
  const askConfirm = (spec: ConfirmSpec): Promise<boolean | 'abort'> => {
    setConfirmSelected(CONFIRM_DECLINE);
    return new Promise(resolve => {
      queueMicrotask(() => setConfirm({ spec, resolve }));
    });
  };

  // The skill the user's own words route to, decided at keypress (#425). Under REIKA_SKILL_AUTO
  // a strong match opens the confirm dialog rather than injecting — the user is the classifier,
  // and the keyword matcher's false positives (a prompt that merely opens with the skill's noun)
  // stop costing a turn. Resolves to the skill name to apply, null for "send as typed", 'abort'
  // for ctrl-c, or undefined when nothing needed asking. Runs BEFORE the busy queue and the
  // expansions so a queued prompt carries its answer and no fetch precedes the question.
  const decideSkillRoute = async (prompt: string): Promise<string | null | 'abort' | undefined> => {
    // A queued prompt replaying: the answer was taken when it was typed.
    if (queuedSkillRouteRef.current !== undefined) {
      const decided = queuedSkillRouteRef.current;
      queuedSkillRouteRef.current = undefined;
      return decided;
    }
    if (config?.skillAuto === 'off' || !config || !bundle) return undefined;
    if (prompt.startsWith('/') || modeRef.current === 'shell') return undefined;
    // Plan mode is excluded on purpose: a skill body landing mid-exploration competes with the
    // plan-mode prompt and the progress ledger. There it stays a suggestion.
    if (modeRef.current !== 'agent' && modeRef.current !== 'vibe') return undefined;
    const match = matchSkill(prompt, bundle.skills);
    const window = config.profiles[activeProfile]?.contextWindow ?? config.contextWindow;
    if (!match || !shouldConfirmInject(match, window)) return undefined;
    const accept = await askConfirm(skillConfirmSpec(match));
    return accept === 'abort' ? 'abort' : accept ? match.skill.name : null;
  };

  // The pasted-link confirm (#448): a URL that is not what the prompt is about — one inside a
  // pasted error, a log line — is asked about rather than fetched, since a GET on a confirm or
  // tracking link has already acted. A URL the prompt IS about (agent/pastedurls.ts's shape gate)
  // needs no dialog and fetches as before. Resolves true/false for the fetch, 'abort' for ctrl-c,
  // undefined when nothing needed asking. Same placement as the skill confirm: before the busy
  // queue, so the entry carries the answer, and before the expansions, so no fetch precedes it.
  const decidePastedUrls = async (prompt: string): Promise<boolean | 'abort' | undefined> => {
    if (queuedUrlFetchRef.current !== undefined) {
      const decided = queuedUrlFetchRef.current;
      queuedUrlFetchRef.current = undefined;
      return decided;
    }
    if (!config || config.pasteFetch === 'off') return undefined;
    if (prompt.startsWith('/') || modeRef.current === 'shell') return undefined;
    const plan = planPastedUrls(prompt);
    if (plan.urls.length === 0 || plan.request) return undefined;
    return askConfirm(pastedUrlConfirmSpec(plan.urls));
  };

  // Route a plain-English prompt to a skill without asking the model. `prompt` is the user's own
  // words (never the expanded text — a fetched page or an @mention'd file mentioning "verify" is
  // not a request to run /verify); `modelText` is what actually gets sent, returned unchanged
  // unless the skill is applied. `route` is the confirm dialog's answer when it fired.
  const routeSkill = (
    prompt: string,
    modelText: string,
    route: string | null | undefined,
  ): string => {
    const match = matchSkill(prompt, bundle?.skills ?? []);
    if (!match) return modelText;
    if (route === match.skill.name) {
      pendingNoticesRef.current.push({
        role: 'system',
        // Says what actually happened, not just that something matched: the body is in the
        // prompt the model receives, and nothing between here and the request removes it (#398).
        content: `Skill /${match.skill.name} applied — its body was prepended to this prompt (matched: ${match.matched.join(', ')}).`,
        tone: 'info',
      });
      pendingSkillRef.current = match.skill.name;
      return `${match.skill.body}\n\n${modelText}`;
    }
    // The dialog replaces the hint when it fires: the user has just seen the skill and declined
    // it, and a line saying "start with /x to apply it" right after that is the nag.
    if (route === null) {
      suggestedSkillsRef.current.add(match.skill.name);
      return modelText;
    }
    if (suggestedSkillsRef.current.has(match.skill.name)) return modelText;
    suggestedSkillsRef.current.add(match.skill.name);
    // A hint, not a handoff: the prompt goes through as typed. Said outright — "run it with /x"
    // read as an instruction to go do that instead (#398).
    pendingNoticesRef.current.push({
      role: 'system',
      content: `Skill hint: /${match.skill.name} — ${match.skill.description}. Prompt sent unchanged; start with /${match.skill.name} to apply it.`,
      tone: 'info',
    });
    return modelText;
  };

  // Drain the queue once the agent is idle again. Replays messages in order
  // through the normal onSubmit path: image attachments go back onto
  // imageAttachmentsRef and the markers are re-appended to the text so the
  // regular image pipeline (hasImageMarker → attachImageBlocks) applies.
  // onSubmit re-seals itself while busy, so a still-busy replay just lands
  // back on the queue.
  // Held while a confirm is up too: a replay under an open dialog could open a second one over
  // it, and the first prompt's answer would never arrive.
  useEffect(() => {
    if (status !== 'idle' || pending !== null || confirm !== null) return;
    if (queueRef.current.length === 0) return;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueue(rest);
    const images = next.images ?? [];
    imageAttachmentsRef.current = images;
    queuedSkillRouteRef.current = next.skill;
    queuedUrlFetchRef.current = next.fetchUrls;
    const markers = images.map(img => img.marker).join(' ');
    void onSubmit(next.content + (markers ? ` ${markers}` : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, pending, confirm, queue]);

  const onSubmit = async (input: string) => {
    // An answer being typed for `ask_user` — not a message for the model. Intercepted ahead of the
    // busy-queue branch below: a question only exists mid-turn, so every such submit would otherwise
    // be queued as the user's next prompt.
    const q = questionRef.current;
    const typing = questionTypingRef.current;
    if (q && typing) {
      const text = input.trim();
      // An empty own-answer isn't an answer; leave the box open rather than resolving with nothing.
      // An empty note is fine — it just means "this option, no comment".
      if (typing.forIndex === undefined && !text) return;
      setInputValue('');
      setSuggestionState(null);
      setQuestion(null);
      setQuestionTyping(null);
      if (typing.forIndex === undefined) {
        q.resolve({ text });
      } else {
        q.resolve({
          text: q.request.options[typing.forIndex].label,
          index: typing.forIndex,
          ...(text ? { notes: text } : {}),
        });
      }
      return;
    }
    // /save runs immediately even while a turn is in flight (#226): the point of saving mid-run
    // is to snapshot the conversation the moment something looks off and hand it to another
    // agent, without aborting the turn to get there. It is safe to run now because it only reads
    // the scrollback and the usage refs — nothing the loop is writing to. Every other command
    // still waits: the rest either change what the running turn is doing (mode, model, cwd) or
    // reset it. Booting is excluded — there is no config/bundle to save under yet.
    if (config && bundle && status !== 'idle' && isSaveCommand(input)) {
      setInputValue('');
      setSuggestionState(null);
      const trimmed = input.trim();
      setInputHistory(prev => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
      await handleCommand(trimmed);
      return;
    }
    // While a turn is running (or the session is still booting), don't drop the
    // message — hold it and replay it through this same path once idle. A
    // scrollback receipt records what was queued; the ephemeral list above the
    // input shows the backlog live and clears as the queue drains.
    if (!config || !bundle || status !== 'idle') {
      const trimmed = input.trim();
      const images = imageAttachmentsRef.current;
      if (!trimmed && images.length === 0) return;
      // Asked now, while the user is at the keyboard, and carried on the entry: the drain may
      // run with nobody at the desk. A ctrl-c drops the prompt, still in the box to edit.
      const route = await decideSkillRoute(trimmed);
      if (route === 'abort') return;
      const fetchUrls = await decidePastedUrls(trimmed);
      if (fetchUrls === 'abort') return;
      const msg: QueuedMessage = {
        content: trimmed,
        images: images.length > 0 ? images : undefined,
        ...(route !== undefined ? { skill: route } : {}),
        ...(fetchUrls !== undefined ? { fetchUrls } : {}),
      };
      imageAttachmentsRef.current = [];
      queueRef.current = [...queueRef.current, msg];
      setQueue(queueRef.current);
      setMessages(prev => [...prev, { role: 'system', content: queueReceipt(msg), tone: 'info' }]);
      // Clear the box just like the normal submit path does below — the
      // queued list above the input is now the source of truth for it.
      setInputValue('');
      setSuggestionState(null);
      return;
    }
    // Free the server slot for the real request (the engine keeps already-processed KV in its
    // slot cache on disconnect, so an interrupted warm still pays off). Unconditional: slash
    // commands (/cd re-bundles, /model switches) and shell submits also land here.
    warmerRef.current.cancel('submit');
    const trimmed = input.trim();
    // Before the box clears: the confirm dialog sits over the input, and the prompt it is asking
    // about should still be visible underneath. A ctrl-c leaves it there to edit.
    const route = await decideSkillRoute(trimmed);
    if (route === 'abort') return;
    const fetchUrls = await decidePastedUrls(trimmed);
    if (fetchUrls === 'abort') return;
    setInputValue('');
    setSuggestionState(null);
    if (!trimmed) return;
    // Record for ArrowUp/ArrowDown recall, skipping consecutive duplicates.
    setInputHistory(prev => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      return;
    }
    if (modeRef.current === 'shell') {
      await runShell(expandPastes(trimmed, pastedTextsRef.current));
      return;
    }
    if (submitBusyRef.current) return;
    submitBusyRef.current = true;
    let modelText: string;
    let display: string;
    try {
      const expansion = await expandMentions(trimmed, bundle.cwd, {
        ocr: systemOcr(config.ocrLangs),
      });
      display = expansion.display;
      pendingNoticesRef.current.push(
        ...expansion.notices.map(content => ({
          role: 'system' as const,
          content,
          tone: 'warn' as const,
        })),
      );
      // Scans `trimmed`, never the expanded text: a URL inside an @mention'd file is file
      // content, not a link the user handed over.
      const urls = await expandPastedUrls(trimmed, {
        mode: config.pasteFetch,
        incidental: fetchUrls,
        onStart: count => setExpanding(`Fetching ${count} pasted link${count > 1 ? 's' : ''}`),
      });
      pendingNoticesRef.current.push(
        ...urls.notices.map(n => ({ role: 'system' as const, content: n.text, tone: n.tone })),
      );
      // Clipboard attachments are consumed by the turn that sends them: the marker stays visible
      // in the bubble, but recalling that text from history later must not silently re-attach an
      // image the user has moved on from.
      modelText = attachImageBlocks(expansion.augmented, imageAttachmentsRef.current);
      imageAttachmentsRef.current = [];
      if (urls.blocks.length > 0) modelText = `${urls.blocks.join('\n\n')}\n\n${modelText}`;
      modelText = routeSkill(trimmed, modelText, route);
      // Last, so everything above reads the user's own words: a marker is the paste's stand-in
      // for @mention, URL and skill matching alike — text the user pasted is content, not a
      // request to fetch a link inside it. The marker survives in `display`, keeping the user
      // bubble (and the input history entry) short while the model gets the full text.
      modelText = expandPastes(modelText, pastedTextsRef.current);
    } finally {
      setExpanding(null);
      submitBusyRef.current = false;
    }
    if (modeRef.current === 'vibe') {
      await runVibeTurn(modelText, display !== modelText ? display : undefined);
      return;
    }
    await submitToModel(modelText, display !== modelText ? display : undefined);
  };

  // Latch the typecheck indicator: show immediately when a check starts, but defer hiding by
  // TYPECHECK_LINGER_MS so a fast check stays on screen long enough to see. A new check cancels a
  // pending hide so back-to-back checks read as continuous.
  const onTypecheckChange = (checking: boolean) => {
    if (typecheckHideTimerRef.current) {
      clearTimeout(typecheckHideTimerRef.current);
      typecheckHideTimerRef.current = null;
    }
    if (checking) {
      setTypechecking(true);
    } else {
      typecheckHideTimerRef.current = setTimeout(() => {
        setTypechecking(false);
        typecheckHideTimerRef.current = null;
      }, TYPECHECK_LINGER_MS);
    }
  };
  // Immediate, un-lingered clear for turn boundaries.
  const resetTypecheck = () => {
    if (typecheckHideTimerRef.current) {
      clearTimeout(typecheckHideTimerRef.current);
      typecheckHideTimerRef.current = null;
    }
    setTypechecking(false);
  };

  const submitToModel = async (
    modelText: string,
    displayOverride?: string,
    // For this turn only: overrides which mode's tools + prompt are used, bypassing the `mode`
    // closure. Needed by /implement, which flips to agent mode and submits in the same tick — the
    // setMode('agent') above hasn't flushed yet, so the closure would still read 'plan'.
    modeOverride?: Mode,
  ): Promise<Message[]> => {
    // Everything the turn appended (user echo, assistant rounds, tool receipts), so a caller can
    // chain on the outcome — vibe mode gates its implement phase on planWritten() over this.
    const appended: Message[] = [];
    // Consumed here whether or not the turn runs, so a skill can never leak onto a later prompt.
    const skill = pendingSkillRef.current;
    pendingSkillRef.current = undefined;
    if (!config || !bundle) return appended;
    const activeMode = modeOverride ?? mode;
    // What this turn is recorded as on its prompt, which is not always what it runs as (vibe).
    const recordedMode = turnMode(modeRef.current, activeMode);
    setStatus('busy');
    setPhase('thinking');
    // The startup probe found no server; this turn is about to need one, so ask again first and
    // let the window govern this turn rather than the next. Awaited: a server that is up answers
    // in milliseconds, and one that is not fails the chat call right after anyway.
    let turnConfig = config;
    const profile = config.profiles[activeProfile];
    if (windowRetryRef.current.has(activeProfile) && profile?.contextWindow == null) {
      const probe = await probeModelLimits(profile);
      if (probe.reached) windowRetryRef.current.delete(activeProfile);
      const notice = probedLimitsNotice(probe);
      if (notice) {
        turnConfig = withProbedLimits(config, activeProfile, probe);
        setConfig(turnConfig);
        pendingNoticesRef.current.push({ role: 'system', content: notice });
      }
    }
    resetTypecheck();
    setReasoningSpin(false);
    streamingRef.current = '';
    reasoningRef.current = '';
    toolRef.current = '';
    setStreaming('');
    setStreamingReasoning('');
    setStreamingTool('');
    // Cleared up front; the turn's seed (onPlanProgress fires early in runTurn when a written plan
    // is in history) restores it. A turn with no tracked plan leaves the panel gone — no stale
    // checklist lingering after the conversation moves on.
    setPlanSteps(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runTurn({
        userInput: modelText,
        userDisplay: displayOverride,
        userSkill: skill,
        // The persistent model history itself, not a copy: the loop appends this turn's messages
        // and folds older spans in place, and both must survive to the next turn (#183).
        history: modelHistoryRef.current,
        bundle,
        config: resolveProfile(turnConfig, activeProfile),
        // Plan mode: read-only tools + the plan prompt. Chat mode: knowledge-only tools. Minimal
        // mode: the shell alone, with a prompt carrying no project context (#391).
        tools: turnTools(activeMode, {
          agent: tools,
          plan: planTools(),
          chat: chatToolsList,
          minimal: minimalTools(),
        }),
        payloads,
        signal: controller.signal,
        requestApproval: config.autoApprove === 'bypass' ? undefined : requestApproval,
        requestQuestion,
        promptMode: turnPromptMode(activeMode),
        minimalPrompt: isMinimalPrompt(activeMode),
        onMessage: raw => {
          // The prompt carries the turn's mode from here on (the loop has no notion of one), so a
          // saved transcript can say what each turn was. See store/transcript.ts summarizeModes.
          const msg: Message = raw.role === 'user' ? { ...raw, mode: recordedMode } : raw;
          appended.push(msg);
          if (msg.role === 'assistant') {
            streamingRef.current = '';
            reasoningRef.current = '';
            setStreaming('');
            setStreamingReasoning('');
          }
          if (msg.role === 'tool') {
            toolRef.current = '';
            setStreamingTool('');
            // Keep `@` autocomplete current with files the model writes this turn,
            // so a just-created file is attachable without a restart or /cd. The
            // diff path is relative (write/edit emit `relative(cwd, …)`), matching
            // fileIndex. addFileToIndex no-ops on existing/filtered paths.
            //
            // That relativeness is load-bearing, not incidental: `ignore` throws a
            // RangeError on an absolute path, so an out-of-project write would take
            // the turn down here. write/edit keep a separate `display` string for the
            // user- and model-facing text and never put it on `diff.path`.
            // A bash command's changes qualify the same way, minus deletions and anything that
            // reached outside cwd (`../` is exactly what `ignore` throws on).
            const written = [
              ...(msg.diff?.path ? [msg.diff.path] : []),
              ...(msg.changes?.files ?? [])
                .filter(f => f.kind !== 'deleted' && !f.path.startsWith('..'))
                .map(f => f.path),
            ];
            if (written.length > 0) {
              setBundle(prev => {
                if (!prev) return prev;
                const next = written.reduce(
                  (idx, p) => addFileToIndex(idx, p, prev.ignore),
                  prev.fileIndex,
                );
                return next === prev.fileIndex ? prev : { ...prev, fileIndex: next };
              });
            }
          }
          if (msg.role === 'user' && pendingNoticesRef.current.length > 0) {
            const notices = pendingNoticesRef.current;
            pendingNoticesRef.current = [];
            setMessages(prev => [...prev, msg, ...notices]);
            return;
          }
          setMessages(prev => [...prev, msg]);
        },
        onContentDelta: delta => {
          streamingRef.current += delta;
          scheduleFlush();
        },
        onReasoningDelta: delta => {
          reasoningRef.current += delta;
          scheduleReasoningFlush();
        },
        onToolProgress: chunk => {
          toolRef.current += chunk;
          scheduleToolFlush();
        },
        onPhase: p => {
          // Leaving the thinking phase ends the reasoning block — clear any spin hint.
          if (p !== 'thinking') setReasoningSpin(false);
          setPhase(p);
        },
        onSubagent: setSubagentLive,
        onCompactionNote: setNoteLive,
        onTypecheck: onTypecheckChange,
        onRecovering: setRecovering,
        // Copy: the loop mutates its tracker array in place, so a same-reference set wouldn't
        // re-render.
        onPlanProgress: steps => setPlanSteps(steps.map(s => ({ ...s }))),
        onReasoningStatus: setReasoningSpin,
        onReasoningReset: () => {
          // Loop-break recovery: drop the degenerate looped reasoning's live preview so the recovery
          // notice is visible and the next round streams into a fresh Thinking block instead of
          // appending onto the looped text (#55).
          reasoningRef.current = '';
          setStreamingReasoning('');
          setReasoningSpin(false);
          // The compaction report round (#280) streams its note as content and commits it as a
          // system notice, which does not clear the content preview the way an assistant commit
          // does — without this the round's real reply would stream onto the note's tail.
          streamingRef.current = '';
          setStreaming('');
        },
        onUsage: u => {
          setLastUsage(u);
          setTotalUsage(t => ({
            promptTokens: t.promptTokens + u.promptTokens,
            completionTokens: t.completionTokens + u.completionTokens,
            ...(u.cachedTokens != null
              ? { cachedTokens: (t.cachedTokens ?? 0) + u.cachedTokens }
              : t.cachedTokens != null
                ? { cachedTokens: t.cachedTokens }
                : {}),
          }));
        },
        onContextEstimate: t => setEstimatedContext(t),
        priorShrink: shrinkRef.current,
        onShrink: (event: ShrinkEvent, counts: ShrinkCounts) => {
          shrinkRef.current = counts;
          setShrink(counts);
          // Stamp the turn the way the status line counts turns (assistant messages so far), so
          // the saved event lines up with the `turn N` a reader sees in the header.
          const turn = messagesRef.current.filter(m => m.role === 'assistant').length + 1;
          shrinkEventsRef.current = [...shrinkEventsRef.current, { turn, ...event }];
        },
        priorCalibration: calibrationRef.current,
        onCalibration: f => {
          calibrationRef.current = f;
        },
        priorPrefillRate: prefillRateRef.current,
        onPrefillRate: r => {
          prefillRateRef.current = r;
        },
        priorDecodeRate: decodeRateRef.current,
        onDecodeRate: r => {
          decodeRateRef.current = r;
          setDecodeRate(r);
        },
        prefixTrace: prefixTraceRef.current,
      });
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', content: (e as Error).message }]);
    } finally {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (reasoningFlushTimerRef.current !== null) {
        clearTimeout(reasoningFlushTimerRef.current);
        reasoningFlushTimerRef.current = null;
      }
      if (toolFlushTimerRef.current !== null) {
        clearTimeout(toolFlushTimerRef.current);
        toolFlushTimerRef.current = null;
      }
      streamingRef.current = '';
      reasoningRef.current = '';
      toolRef.current = '';
      setStreaming('');
      setStreamingReasoning('');
      setStreamingTool('');
      setSubagentLive(false);
      setNoteLive(false);
      resetTypecheck();
      setReasoningSpin(false);
      setStatus('idle');
      abortRef.current = null;
    }
    return appended;
  };

  // Vibe mode (#45): one prompt runs the full plan→implement pipeline. Phase 1 is a normal
  // plan-mode turn (read-only tools, plan prompt); if it ends with a written plan, phase 2
  // executes it immediately as a normal agent turn (the same prompt /implement submits).
  // Approval wiring is untouched — each phase asks exactly as its underlying mode would, so
  // REIKA_AUTO_APPROVE / the session toggle stay the sole source of truth for what auto-runs.
  const runVibeTurn = async (modelText: string, displayOverride?: string): Promise<void> => {
    const planMsgs = await submitToModel(modelText, displayOverride, 'plan');
    // No planFinal marker means the plan phase was aborted (ctrl-c) or dead-ended — never
    // chain edits off a turn that didn't actually commit a plan.
    if (!planWritten(planMsgs)) {
      setMessages(prev => [
        ...prev,
        {
          role: 'system',
          content: 'vibe: the plan phase ended without a written plan — skipping implementation.',
        },
      ]);
      return;
    }
    // No history threading needed: the plan phase appended straight into the shared model history,
    // so the implement phase picks it up from there (the `messages` closure never would have).
    await submitToModel(buildImplementPrompt(''), '/implement (vibe)', 'agent');
  };

  // The status line's context gauge: raw window for the ratio, shed ceiling for the percent. Same
  // operands the transcript header freezes at save time, so the two can't disagree.
  const statusProfile = config?.profiles[activeProfile];
  const statusWindow = statusProfile?.contextWindow ?? config?.contextWindow;
  const statusUsable =
    statusWindow && config
      ? Math.round(
          compactThreshold(statusWindow, statusProfile?.minGenTokens ?? config.minGenTokens),
        )
      : undefined;

  // Live rows above a dialog (plan checklist, queued messages) it has to leave viewport room for.
  const dialogReservedRows =
    (planSteps && (mode === 'agent' || mode === 'vibe') ? planProgressRows(planSteps) : 0) +
    (queue.length > 0 ? queue.length + 1 : 0);

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text bold>Error</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={headerItems}>
        {(h, i) => (
          <Splash key={i} model={h.model} cwd={h.cwd} version={h.version} subagent={h.subagent} />
        )}
      </Static>
      {status === 'loading' ? (
        <Text>Loading…</Text>
      ) : (
        <>
          <Scrollback
            messages={messages}
            streaming={status === 'busy' ? streaming : ''}
            streamingReasoning={status === 'busy' ? streamingReasoning : ''}
            streamingTool={status === 'busy' ? streamingTool : ''}
            streamingNested={subagentLive || noteLive}
            streamingBar={noteLive ? theme.info : undefined}
            chromeRows={
              planSteps && (mode === 'agent' || mode === 'vibe') ? planProgressRows(planSteps) : 0
            }
          />
          {planSteps && (mode === 'agent' || mode === 'vibe') ? (
            <PlanProgress steps={planSteps} />
          ) : null}
          {/* Spinner and queue sit *above* any overlay, not between it and the input: the
              overlay drops its bottom border and the input its top one so the two merge into
              one frame, and anything rendered in that gap lands inside the frame. */}
          {status === 'busy' && pending === null && question === null ? (
            <Working
              // Definite harness actions (typecheck, loop recovery) take priority over the soft spin
              // hint — they're things the harness is actively doing, not a maybe.
              label={
                typechecking
                  ? 'Typechecking'
                  : recovering
                    ? 'Recovering from a loop'
                    : reasoningSpin
                      ? 'Thinking — may be looping (ctrl-c to abort)'
                      : noteLive
                        ? 'Writing compaction note'
                        : subagentLive
                          ? 'Subagent working'
                          : undefined
              }
              accent={
                typechecking || recovering || noteLive
                  ? theme.info
                  : reasoningSpin
                    ? theme.warning
                    : subagentLive
                      ? theme.subagent
                      : undefined
              }
            />
          ) : (pasting ?? expanding) ? (
            // Same spinner while idle: a paste, or a submit that has to fetch a pasted link, is a
            // harness action with a visible wait — it should read like the typecheck gate rather
            // than like the app having stalled.
            <Working label={pasting ?? expanding ?? undefined} accent={theme.info} />
          ) : null}
          <QueuedList queue={queue} />
          {pending ? (
            <Approval
              request={pending.request}
              selectedIndex={approvalSelected}
              reservedRows={dialogReservedRows}
            />
          ) : question ? (
            <Question
              request={question.request}
              selectedIndex={questionSelected}
              typing={questionTyping}
              reservedRows={dialogReservedRows}
            />
          ) : modelSelect ? (
            <ModelSelect
              targets={modelSelect}
              selectedIndex={modelSelected}
              currentModel={config?.profiles[activeProfile]?.model ?? config?.model ?? ''}
              baseURL={config?.baseURL ?? ''}
              subagent={
                config?.subagentModel &&
                config.subagentModel !== (config.profiles[activeProfile]?.model ?? config.model)
                  ? config.subagentModel
                  : undefined
              }
            />
          ) : confirm ? (
            <Confirm spec={confirm.spec} selectedIndex={confirmSelected} />
          ) : null}
          <Input
            // The question dialog is modal only while its list is up; once the user is typing an
            // answer the input has to be live, since it IS the answer field.
            disabled={
              pending !== null ||
              modelSelect !== null ||
              confirm !== null ||
              (question !== null && questionTyping === null)
            }
            attachedAbove={
              pending !== null || question !== null || modelSelect !== null || confirm !== null
            }
            attachedBelow={suggestionState !== null}
            reservedRows={
              question
                ? questionDialogHeight(question.request, questionTyping, dialogReservedRows)
                : 0
            }
            suggesting={!!suggestionState && suggestionState.items.length > 0}
            history={inputHistory}
            mode={mode}
            value={inputValue}
            onChange={onInputChange}
            onSubmit={onSubmit}
            onPasteImage={onPasteImageSafely}
            onPasteText={onPasteText}
            placeholder={
              mode === 'shell'
                ? 'Run a shell command'
                : mode === 'vibe'
                  ? 'Describe a change — it plans first, then implements'
                  : promptPlaceholder()
            }
          />
          {suggestionState ? (
            <Suggestions state={suggestionState} selectedIndex={suggestionSelected} />
          ) : null}
          <Status
            model={config?.profiles[activeProfile]?.model ?? config?.model ?? ''}
            turns={messages.filter(m => m.role === 'assistant').length}
            status={status === 'busy' ? phase : status}
            elapsed={status === 'busy' ? elapsed : null}
            usage={totalUsage}
            contextTokens={lastUsage?.promptTokens ?? estimatedContext}
            contextWindow={statusWindow}
            contextUsable={statusUsable}
            sheds={shrink.sheds}
            folds={shrink.folds}
            cachedTokens={lastUsage?.cachedTokens}
            decodeRate={decodeRate}
            pr={pr}
            autoApprove={
              config?.autoApprove === 'bypass'
                ? 'bypass'
                : effectiveAutoApprove(config, sessionAutoApprove) === 'safe'
                  ? 'safe'
                  : undefined
            }
            modeTag={mode}
            exitArmed={exitArmed && status === 'idle' && pending === null && inputValue === ''}
          />
        </>
      )}
    </Box>
  );
}
