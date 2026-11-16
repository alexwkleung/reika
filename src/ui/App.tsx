import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Box,
  Static,
  Text,
  measureElement,
  useApp,
  useInput,
  useStdout,
  type DOMElement,
} from 'ink';
import { inputFloorEnabled, installBottomFloor } from './bottomfloor.js';
import { Splash } from './Splash.js';
import { Scrollback } from './Scrollback.js';
import { VERSION } from '../version.js';
import { Input } from './Input.js';
import { Working } from './Working.js';
import { WORKING_WORDS } from './workingwords.js';
import { usePendingRow } from './pendingrow.js';
import { PlanProgress, planProgressRows } from './PlanProgress.js';
import { Status, useStatusLayout, type StatusProps } from './Status.js';
import type { Session } from '../session.js';
import { theme } from './theme.js';
import { Approval } from './Approval.js';
import {
  APPROVAL_FEEDBACK_INDEX,
  APPROVAL_OPTIONS,
  CONFIRM_ACCEPT,
  CONFIRM_DECLINE,
  type ConfirmSpec,
} from './dialogspecs.js';
import { Confirm } from './Confirm.js';
import { Question, questionDialogHeight, type QuestionTyping } from './Question.js';
import { loadConfig, resolveDefaultMode } from '../config.js';
import { loadLastState, saveLastState, startMode } from '../laststate.js';
import { effectiveAutoApprove } from '../approval.js';
import { debugEnabled } from '../debug.js';
import { noteFrameState } from './framedrops.js';
import { compactThreshold } from '../agent/compaction.js';
import { withLiveUsage } from '../agent/liveusage.js';
import { nextImageMarker, type ImageAttachment } from '../agent/attachments.js';
import { submitStageLabel } from '../agent/submitinput.js';
import { clipboardImageSupported, readClipboardImage } from './clipboard.js';
import { isWarmEdge } from './warmtrigger.js';
import { Suggestions, suggestionRows } from './Suggestions.js';
import { ModelSelect } from './ModelSelect.js';
import { mcpStartupLine, prefillLabel } from './format.js';
import { useContentWidth } from './layout.js';
import { ResumeSelect } from './ResumeSelect.js';
import { loadSession, type SessionEntry, type SessionSides } from '../store/sessions.js';
import { type ModelTarget } from './models.js';
import { nextMode } from '../agent/modes.js';
import { acceptSuggestion, type SuggestionState } from './suggest.js';
import { buildSummary, hasActivity } from './summary.js';
import { QueuedList } from './QueuedList.js';
import { createController, type InputFrontEnd, type TurnFrontEnd } from '../controller.js';
import { useLiveView } from './liveview.js';
import { type SubmitAnswers } from '../agent/busyqueue.js';
import { rememberPaste, type PastedText } from './pastes.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  Config,
  Message,
  Mode,
  QuestionAnswer,
  QuestionRequest,
} from '../types.js';

export { TYPECHECK_LINGER_MS } from './liveview.js';

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

// An answered approval's rows: held this long for output to fill them, then whatever is still blank
// shrinks by this fraction a frame (at least a row), so the input slides up rather than snapping.
// Once the command has printed, the ease waits for it to go quiet this long instead: a command
// printing a line every half second fills the rows, where easing them out between lines slid the
// input up and then had each line push it back down.
const HOLD_GRACE_MS = 300;
const HOLD_QUIET_MS = 1500;
const HOLD_FRAME_MS = 32;
const HOLD_EASE = 0.35;

// A resumed session reaches the scrollback a slice at a time (#854): a commit renders its messages'
// markdown, highlighting and wrap synchronously, and one commit for the whole session held the
// event loop — the resuming spinner's timer included — for as long as that took (~2s at 460
// messages). Slices are sized to about this long each, so the spinner ticks between them.
const RESUME_SLICE_MS = 40;
const RESUME_FIRST_SLICE = 4;

// Scaled from how long the last slice took, so its cost does not depend on what the messages hold;
// growth is held to doubling, since a run of tiny messages says little about the next ones.
function nextResumeSliceSize(size: number, tookMs: number): number {
  const scaled = Math.round((size * RESUME_SLICE_MS) / Math.max(tookMs, 1));
  return Math.min(Math.max(scaled, 1), size * 2);
}

export function App() {
  const { exit } = useApp();
  // What the pre-session frame says while bootstrap runs, or undefined for the usual launch where
  // there is nothing worth saying yet (#265). Only ever read in the `loading` frame: once the
  // session lands, the splash and the scrollback describe the session itself.
  const [loadingNote, setLoadingNote] = useState<string | undefined>(undefined);
  // The scrollback, the other side's stash, the mode, the status, the queue of prompts typed while
  // busy, the open dialogs and the running turn's live state live in the controller
  // (src/controller.ts); this component renders them and changes them only through it. The launch
  // mode is the last session's (#365) unless REIKA_DEFAULT_MODE was given at launch
  // (REIKA_PLAN_EXPERIMENT=1 is the legacy alias for plan); a .env value is only the fallback.
  const [controller] = useState(() =>
    createController({
      mode: startMode(loadLastState()),
      remember: saveLastState,
      pollPr: true,
    }),
  );
  // The running turn as drawn (liveview.ts): the controller's live state on this front end's
  // timing — the stream flush, the typecheck linger and the estimate's once-a-second cadence.
  const liveView = useLiveView(controller);
  const {
    phase,
    content: streaming,
    reasoning: streamingReasoning,
    tool: streamingToolBlock,
    pending: runningCall,
    plan: planSteps,
    subagent: subagentLive,
    note: noteLive,
    typechecking,
    recovering,
    looping: reasoningSpin,
    promptProgress,
  } = liveView.view;
  const streamingTool = streamingToolBlock?.output ?? '';
  const streamingToolName = streamingToolBlock?.name ?? '';
  // The call running right now (#509), by name: what the scrollback's live "…ing" row is drawn from.
  const pendingTool = runningCall?.name ?? '';
  // An answered approval or question keeps its rows for a moment: closing a 13-row dialog in one
  // frame dropped the input 13 rows, and output arriving in the grace window fills that space
  // instead. Whatever is still blank after it eases out (HOLD_*). An approval's hold is keyed to its
  // call's start stamp (`forCall`), so the next call never inherits it; a question's lasts past its
  // call, whose answer commits at once, into the model's next round.
  const [dialogHold, setDialogHold] = useState<{
    rows: number;
    at: number;
    forCall: boolean;
    command?: string;
  } | null>(null);
  // Forced past the delay by an answered approval (its frame collapses the dialog into the row, #897)
  // and by streamed output, which would otherwise draw first and drop 1–2 rows when the row arrives.
  const pendingRow = usePendingRow(
    pendingTool,
    runningCall?.call ?? 0,
    streamingTool !== '' || (dialogHold?.forCall === true && dialogHold.at === runningCall?.since),
  );
  const heldFrameRef = useRef<DOMElement>(null);
  const heldFrameRowsRef = useRef(0);
  // The blank the hold is leaving right now, which is what the ease-out shrinks.
  const holdSpacerRef = useRef<DOMElement>(null);
  // The bottom floor (bottomfloor.ts) keeps the frame's last row on the terminal's. Released on
  // exit, so the final frame does not leave its slack in the shell's scrollback.
  const { stdout: inkStdout } = useStdout();
  const inputFloor = inputFloorEnabled(inkStdout);
  const floorReleasedRef = useRef(false);
  useLayoutEffect(() => {
    if (!inputFloor) return;
    return installBottomFloor(
      () => heldFrameRef.current,
      inkStdout,
      () => floorReleasedRef.current,
    );
  }, [inputFloor, inkStdout]);
  const { tick: tickLiveUsage, lastOutputAtRef: lastLiveOutputAtRef } = liveView;
  // The session owns the config, the active profile, the bundle and everything a turn threads to
  // the next (#403); App renders from its snapshot and never keeps a copy of its own.
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]),
    () => session?.getSnapshot() ?? null,
  );
  const config = snapshot?.config ?? null;
  const bundle = snapshot?.bundle ?? null;
  const activeProfile = snapshot?.profile ?? 'default';
  const [elapsed, setElapsed] = useState(0);
  const [approvalSelected, setApprovalSelected] = useState(0);
  // Typing the reason for a decline: like `questionTyping`, the input box underneath is the field.
  const [approvalTyping, setApprovalTyping] = useState(false);
  // An `ask_user` question waiting on the user (#198). Modal like Approval, with one difference: the
  // input box stays LIVE underneath once `questionTyping` is set, because the free-text row hands the
  // answer to Input rather than to a field rebuilt in the dialog.
  const [questionSelected, setQuestionSelected] = useState(0);
  const [questionTyping, setQuestionTyping] = useState<QuestionTyping | null>(null);
  // The harness asking before submit (#425 skill confirm, #448 pasted-link confirm, #561
  // /implement's mode): one modal slot like Approval, whatever is being asked about. Resolves the
  // chosen row, or 'abort' (ctrl-c: nothing is sent and the prompt stays in the box).
  const [confirmSelected, setConfirmSelected] = useState<number>(CONFIRM_DECLINE);
  // `pending` is the open approval, `question` an open ask_user, `confirm` the harness asking
  // before a prompt is sent.
  const {
    messages,
    mode,
    status,
    queue,
    replaying,
    preparing,
    history,
    approval: pending,
    question,
    confirm,
    sessionAutoApprove,
    sessionUnattended,
    error,
    usage,
    lastUsage,
    estimatedContext,
    shrink,
    decodeRate,
    pr,
  } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // The estimate is drawn only beside the total it was taken against (#925): the real count reaches
  // this component through the snapshot, which Ink commits separately, so the commit that brings it
  // drops the estimate and the chip neither blinks out nor double-counts.
  const shownUsage = liveView.usage;
  const liveUsage = shownUsage && shownUsage.base === usage ? shownUsage.usage : undefined;
  // `/unattended on|off` (#526) over REIKA_UNATTENDED's launch state. Safe to switch mid-session
  // where `bypass` is not: either direction only ever adds a decline or restores the prompt.
  const unattended = sessionUnattended ?? config?.unattended === true;
  const [headerItems, setHeaderItems] = useState<HeaderItem[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  // Past submissions (oldest→newest) the Input recalls via ArrowUp/ArrowDown,
  // independent of the chat transcript so it spans chat, shell, and commands.
  const [suggestionState, setSuggestionState] = useState<SuggestionState | null>(null);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  // Interactive /model picker (bare /model). Modal like Approval: the input is
  // disabled while it's open and the arrow keys drive the list.
  const [modelSelect, setModelSelect] = useState<ModelTarget[] | null>(null);
  const [modelSelected, setModelSelected] = useState(0);
  // Interactive /resume picker (#1), modal the same way.
  const [resumeSelect, setResumeSelect] = useState<{
    entries: SessionEntry[];
    heading: string;
  } | null>(null);
  const [resumeSelected, setResumeSelected] = useState(0);
  const [exitRequested, setExitRequested] = useState(false);
  floorReleasedRef.current = exitRequested;
  const [exitArmed, setExitArmed] = useState(false);
  // Open PR for the checked-out branch, shown in the status bar. Null until resolved,
  // and whenever the branch has no PR (or `gh` can't tell us).
  // Text extracted from images pasted this turn, keyed by the `[Image N]` marker sitting in the
  // input buffer. Ref-held: the buffer's marker is the visible state, this is just its payload,
  // and re-rendering on paste would fight the Input's own cursor bookkeeping.
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  // Text from pastes too large to sit in the input buffer, keyed by the `[Pasted text #N +412 lines]` marker
  // holding its place there (ui/pastes.ts). Ref-held for the same reason as image attachments.
  // Unlike them it is NOT consumed at submit: the marker is plain text the user can recall from
  // history or leave sitting in a queued message, and it has to still expand when they do.
  const pastedTextsRef = useRef<PastedText[]>([]);
  // Stage label while a ctrl-v paste is in flight; null when idle. Ephemeral by design — the
  // durable record of what got attached is the system notice the paste ends with.
  const [pasting, setPasting] = useState<string | null>(null);
  const pasteBusyRef = useRef(false);
  // Same idea for submit-time expansion, which blocks on the network when the prompt carries a
  // pasted link. Separate from `pasting` so a ctrl-v mid-submit can't clobber either label.
  const [expanding, setExpanding] = useState<string | null>(null);
  // And for /resume: reading a long session is fast, but *rendering* it is not — the commit that
  // hands a 2MB session's 460-odd messages to the scrollback blocks the event loop for ~2s (see
  // the note on the label below), and without this the picker just vanished and the app sat on a
  // stale frame until it landed.
  const [resuming, setResuming] = useState<string | null>(null);
  // Held for the whole resume, slices included: a submit or a mode switch between two slices would
  // land its rows in the middle of the resumed scrollback, or swap it for the other side's.
  const resumingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const exitArmedRef = useRef(false);
  exitArmedRef.current = exitArmed;
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const disarmExit = (): void => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setExitArmed(false);
  };
  const questionSelectedRef = useRef(0);
  questionSelectedRef.current = questionSelected;
  const questionTypingRef = useRef<QuestionTyping | null>(null);
  questionTypingRef.current = questionTyping;
  const approvalSelectedRef = useRef(0);
  approvalSelectedRef.current = approvalSelected;
  const approvalTypingRef = useRef(false);
  approvalTypingRef.current = approvalTyping;
  const confirmSelectedRef = useRef<number>(CONFIRM_DECLINE);
  confirmSelectedRef.current = confirmSelected;
  // What this turn declined under REIKA_UNATTENDED, rolled up into one notice when it ends (#526).
  // Read at each approval and tool call, so a toggle mid-turn applies to the next action.
  const activeProfileRef = useRef('default');
  activeProfileRef.current = activeProfile;
  const inputValueRef = useRef('');
  inputValueRef.current = inputValue;
  // What the box held when the ask_user answer field opened, so backing out discards only the answer.
  const preAnswerDraftRef = useRef('');
  const suggestionStateRef = useRef<SuggestionState | null>(null);
  suggestionStateRef.current = suggestionState;
  const suggestionSelectedRef = useRef(0);
  suggestionSelectedRef.current = suggestionSelected;
  const modelSelectRef = useRef<ModelTarget[] | null>(null);
  modelSelectRef.current = modelSelect;
  const modelSelectedRef = useRef(0);
  modelSelectedRef.current = modelSelected;
  const resumeSelectRef = useRef(resumeSelect);
  resumeSelectRef.current = resumeSelect;
  const resumeSelectedRef = useRef(0);
  resumeSelectedRef.current = resumeSelected;
  useEffect(() => {
    // The config as loaded, which names the subagent model the splash shows.
    let loaded: Config | null = null;
    void controller.boot({
      cwd: process.cwd(),
      loadConfig,
      lastState: loadLastState(),
      defaultMode: resolveDefaultMode(),
      // Said before the await, because the wait is the point: a configured MCP server is the one
      // leg of bootstrap that can hold this frame for seconds (a subprocess handshake), and the
      // only one whose names are already known. No servers → nothing is painted at all (#265).
      onConfig: cfg => {
        loaded = cfg;
        setLoadingNote(mcpStartupLine(cfg.mcpServers ?? []));
      },
      onSession: s => {
        sessionRef.current = s;
        setSession(s);
        const subagentModel = loaded?.subagentModel;
        setHeaderItems(prev => [
          ...prev,
          {
            kind: 'splash',
            model: s.config.model,
            cwd: s.bundle.cwd,
            version: VERSION,
            subagent: subagentModel && subagentModel !== s.config.model ? subagentModel : undefined,
          },
        ]);
      },
    });
    // Boot runs once: the controller is created once and read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      // MCP servers are child processes: reika leaving is what should end them (#265). The module's
      // own exit hook is the backstop for a crash; this is the orderly path.
      void sessionRef.current?.mcp.close();
    },
    [],
  );

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
      tickLiveUsage();
    }, 1000);
    return () => clearInterval(id);
  }, [status, pending, question, tickLiveUsage]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const hadPending = controller.approval !== null;
      const hadQuestion = controller.question !== null;
      // Typing a decline's reason: back out to the options, as the question's field does (#651).
      // Nothing is decided yet, so neither the approval nor the turn may end here.
      if (hadPending && approvalTypingRef.current) {
        setInputValue(preAnswerDraftRef.current);
        setSuggestionState(null);
        setApprovalTyping(false);
        return;
      }
      // Interrupt anything in flight: decline a pending approval, drop an unanswered question,
      // abort a turn.
      if (hadPending) answerApproval(false);
      if (hadQuestion) {
        // Typing an answer or a note (#651): ctrl-c backs out of the field to the option list
        // instead of dropping the question. The field is live and owns the keyboard, so this is the
        // only route back to the list, and ask_user is one-shot — dropping it here throws away the
        // menu the turn is waiting on. The list keeps the abort, so a second ctrl-c still ends the
        // dialog. Returned rather than fallen through: nothing has been decided, and the code below
        // would abort the whole turn with it. The typed answer is discarded — left in the box it
        // outlives the question and one stray Enter queues it as the next prompt — but a draft that
        // was there before the field opened comes back.
        if (questionTypingRef.current) {
          setInputValue(preAnswerDraftRef.current);
          setSuggestionState(null);
          setQuestionTyping(null);
          return;
        }
        answerQuestion(null);
        setQuestionTyping(null);
      }
      // An open confirm closes first, like the /model picker, and the turn (if one is running)
      // keeps going: the dialog is about the prompt being submitted, not the turn.
      if (!hadPending && !hadQuestion && controller.confirm) {
        controller.answerConfirm('abort');
        return;
      }
      if (controller.abort()) return;
      if (hadPending) return;
      // An open /model or /resume picker closes first, like esc.
      if (modelSelectRef.current) {
        setModelSelect(null);
        return;
      }
      if (resumeSelectRef.current) {
        setResumeSelect(null);
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
    if (controller.approval) {
      // Input owns the keyboard while the reason is typed; a key consumed here is a lost character.
      if (approvalTypingRef.current) return;
      if (key.upArrow) {
        setApprovalSelected(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setApprovalSelected(i => Math.min(APPROVAL_OPTIONS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const sel = approvalSelectedRef.current;
        if (sel === APPROVAL_FEEDBACK_INDEX) {
          // Deferred like the question's field: enabling Input synchronously hands it this Enter.
          preAnswerDraftRef.current = inputValueRef.current;
          setInputValue('');
          queueMicrotask(() => setApprovalTyping(true));
          return;
        }
        if (sel === 0) answerApproval(true);
        else if (sel === 1) answerApproval(false);
        else answerApproval(true, true);
        return;
      }
      if (input === 'y' || input === 'Y') {
        answerApproval(true);
      } else if (input === 'n' || input === 'N') {
        answerApproval(false);
      }
      return;
    }
    const q = controller.question;
    if (q) {
      // Typing the answer: Input owns the keyboard. Nothing here may consume the keystroke, or the
      // answer loses characters to the dialog that asked for it.
      if (questionTypingRef.current) return;
      // Rows are the options plus the always-last "type your own" row.
      const last = q.options.length;
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
        preAnswerDraftRef.current = inputValueRef.current;
        queueMicrotask(() => setQuestionTyping({ forIndex }));
        return;
      }
      if (key.return) {
        const sel = questionSelectedRef.current;
        if (sel === last) {
          // Deferred a microtask: this same keypress is dispatched to every useInput handler with
          // re-renders in between, so enabling Input synchronously hands it the very Enter that
          // opened it and submits an empty answer.
          preAnswerDraftRef.current = inputValueRef.current;
          queueMicrotask(() => setQuestionTyping({}));
          return;
        }
        const chosen = q.options[sel];
        setQuestionTyping(null);
        answerQuestion({ text: chosen.label, index: sel });
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
    const cf = controller.confirm;
    if (cf) {
      // Digits and y/n only move the cursor, as in the question dialog: Enter is the one key that
      // answers, and y lands on the accepting row — the one Approval-trained fingers expect first.
      const last = cf.options.length - 1;
      const digit = Number(input);
      if (key.upArrow) {
        setConfirmSelected(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setConfirmSelected(i => Math.min(last, i + 1));
      } else if (/^[1-9]$/.test(input) && digit - 1 <= last) {
        setConfirmSelected(digit - 1);
      } else if (cf.accept && (input === 'n' || input === 'N')) {
        setConfirmSelected(CONFIRM_DECLINE);
      } else if (cf.accept && (input === 'y' || input === 'Y')) {
        setConfirmSelected(CONFIRM_ACCEPT);
      } else if (key.return) {
        controller.answerConfirm(confirmSelectedRef.current);
      } else if (key.escape) {
        // Unlike Approval and Question, escape is safe here: a split arrow sequence arriving as a
        // bare escape only cancels — nothing is sent and the prompt stays in the box — the same
        // cost the /model picker's escape carries. Approval's escape would decline for the user.
        controller.answerConfirm('abort');
      }
      // Modal: the input is disabled, so nothing else has anywhere to go.
      return;
    }
    const rs = resumeSelectRef.current;
    if (rs) {
      if (key.upArrow) {
        setResumeSelected(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setResumeSelected(i => Math.min(rs.entries.length - 1, i + 1));
      } else if (key.return) {
        const sel = rs.entries[resumeSelectedRef.current];
        setResumeSelect(null);
        if (sel) void resumeSession(sel);
      } else if (key.escape) {
        setResumeSelect(null);
      }
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
        if (sel) controller.pickModel(sel.name);
      } else if (key.escape) {
        setModelSelect(null);
      }
      // Modal: the input is disabled while the picker is open, so no other key
      // has anywhere to go.
      return;
    }
    // Shift+Tab cycles agent → plan → minimal → vibe → grind → chat → shell. Only while idle — mode picks the
    // in-flight turn's tools and prompt, the same reason /plan et al. refuse while busy; a
    // keystroke shouldn't spam that refusal into scrollback, so it just no-ops.
    if (key.tab && key.shift) {
      if (controller.status === 'idle' && !resumingRef.current) {
        transitionMode(nextMode(controller.mode), []);
      }
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

  const resumeSession = async (entry: SessionEntry): Promise<void> => {
    resumingRef.current = true;
    try {
      await loadResumedSession(entry);
    } finally {
      resumingRef.current = false;
    }
  };

  const loadResumedSession = async (entry: SessionEntry): Promise<void> => {
    // Set before the first await, so the frame lands while the file is still being read.
    setResuming(`Resuming "${entry.title ?? 'untitled'}"`);
    let sides: SessionSides;
    try {
      sides = await loadSession(entry.path);
    } catch (e) {
      setResuming(null);
      controller.append({ role: 'error', content: `resume failed: ${(e as Error).message}` });
      return;
    }
    // Save whatever this session had before it is replaced.
    await controller.saveNow();
    const resumed = controller.loadConversation(sides, entry);
    let size = RESUME_FIRST_SLICE;
    for (let at = 0; at < resumed.length;) {
      const slice = resumed.slice(at, at + size);
      const started = performance.now();
      // The first slice replaces the old conversation; the rest extend it.
      if (at === 0) controller.replace(slice);
      else controller.append(...slice);
      at += slice.length;
      if (at >= resumed.length) break;
      // A timer, not a microtask: the spinner ticks on an interval, which only a yield to the timer
      // phase lets fire. Measured past the yield, so the commit counts whenever React flushes it.
      await new Promise(resolve => setTimeout(resolve, 0));
      size = nextResumeSliceSize(size, performance.now() - started);
    }
    setResuming(null);
  };

  const requestExit = (): void => {
    if (hasActivity(controller.messages)) {
      const summary = buildSummary(
        controller.messages,
        controller.getSnapshot().usage,
        controller.startedAt,
        controller.getSnapshot().approvals,
      );
      controller.append({ role: 'system', content: summary, skipAutosave: true });
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
    if (edge) controller.warm(value);
    const next = controller.completions(value);
    setSuggestionState(next);
    setSuggestionSelected(0);
  };

  // The gate itself is the controller's (auto-approve, unattended, the dialog); this only puts
  // the dialog's cursor back on its first row for the next one.
  const requestApproval = (req: ApprovalRequest): Promise<ApprovalAnswer> => {
    setApprovalSelected(0);
    setApprovalTyping(false);
    return controller.requestApproval(req);
  };

  // Answers the open approval. The frame hold and the dialog's close land in one tick, so no
  // frame is drawn between them (#897).
  const answerApproval = (answer: ApprovalAnswer, always = false): void => {
    const req = controller.approval;
    if (!req) return;
    // Only for the call that is running: a subagent's approval names a nested call, and the
    // parent's row (`subagent`) would hold these rows for the whole delegated run.
    const running = controller.runningCall;
    if (running && req.tool === running.name) {
      setDialogHold({
        rows: heldFrameRowsRef.current,
        at: running.since,
        forCall: true,
        command: answer === true && req.tool === 'bash' ? req.preview : undefined,
      });
    }
    controller.answerApproval(answer, { always });
  };

  const requestQuestion = (req: QuestionRequest): Promise<QuestionAnswer | null> => {
    setQuestionSelected(0);
    setQuestionTyping(null);
    return controller.openQuestion(req);
  };

  const answerQuestion = (answer: QuestionAnswer | null): void => {
    if (!controller.question) return;
    setDialogHold({ rows: heldFrameRowsRef.current, at: Date.now(), forCall: false });
    controller.answerQuestion(answer);
  };

  // The mode change Shift+Tab cycling makes. `trailing` lands after any restored history; cycling
  // passes nothing, since the status-bar mode tag is that path's feedback (a mode command's echo
  // and banner are the controller's, in `runCommand`).
  const transitionMode = (next: Mode, trailing: Message[]): void => {
    controller.transition(next, trailing);
  };

  // What a typed line hands the controller: the turn's hooks, the dialog's cursor, the pickers,
  // which only this front end can draw, the shell's output stream and the input box. The
  // attachments and pastes are getters: the controller reads them after the line's questions.
  const inputFrontEnd = (): InputFrontEnd => ({
    turn: turnFrontEnd,
    get pastes() {
      return pastedTextsRef.current;
    },
    get images() {
      return imageAttachmentsRef.current;
    },
    ask: askChoice,
    exit: requestExit,
    pickModel: targets => {
      // Deferred past the current keypress dispatch: Ink hands the same Enter to every useInput
      // handler, and the submit re-renders in between — opening synchronously would let the
      // picker's own handler see that Enter and instantly select the first entry. The cursor is
      // parked on the active entry.
      queueMicrotask(() => {
        setModelSelect(targets);
        setModelSelected(
          Math.max(
            0,
            targets.findIndex(t => t.active),
          ),
        );
      });
    },
    pickSession: list => {
      // Deferred past this keypress for the reason /model's picker is: Ink hands the same Enter to
      // every useInput handler, and an open picker would take it as a selection.
      queueMicrotask(() => {
        setResumeSelect(list);
        setResumeSelected(0);
      });
    },
    // The run is the controller's, and its output streams through the live tool block.
    shell: {},
    onStage: stage => setExpanding(stage ? submitStageLabel(stage) : null),
    // Clipboard attachments are consumed by the line that takes them: recalling that text from
    // history later must not silently re-attach an image the user has moved on from.
    onImagesTaken: () => {
      imageAttachmentsRef.current = [];
    },
    onTaken: () => {
      setInputValue('');
      setSuggestionState(null);
    },
    // Typing the command opened its autocomplete row, and the list only recomputes on an edit: left
    // up, it draws a second `/implement` under the dialog.
    beforeImplementQuestion: () => setSuggestionState(null),
  });

  // Ctrl+V. Outcomes are all persistent scrollback lines rather than spinner states: the user
  // pressed a key expecting an attachment, and "nothing happened" has to be distinguishable
  // from "attached, and here's how much text came out".
  const onPasteImage = async (): Promise<void> => {
    const notice = (content: string, tone: 'info' | 'warn'): void => {
      controller.append({ role: 'system', content, tone });
    };
    if (!clipboardImageSupported()) {
      notice('Image paste reads the system clipboard — macOS and Windows only.', 'warn');
      return;
    }
    // Shell mode submits the buffer to bash, which would try to run `[Image 1]` as a command —
    // there's no model turn for the block to ride along with.
    if (controller.mode === 'shell') {
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
    // The active profile's route (REIKA_<NAME>_VISION is per profile): native bytes, the vision
    // model, or system OCR. The stage label names what is running.
    const label = controller.imageReadLabel();
    if (label) setPasting(label);
    const read = await controller.readImage(bytes, 'clipboard image');
    if (!read.ok) {
      notice(read.notice, 'warn');
      return;
    }
    const marker = nextImageMarker(imageAttachmentsRef.current);
    imageAttachmentsRef.current = [
      ...imageAttachmentsRef.current,
      {
        marker,
        text: read.text,
        source: 'clipboard',
        ...(read.native ? { native: read.native } : {}),
      },
    ];
    // Appended rather than inserted at the cursor: the Input owns cursor state and snaps to the
    // end on any external value change, so a mid-buffer insert would move the caret anyway.
    setInputValue(prev => (prev === '' || prev.endsWith(' ') ? prev : prev + ' ') + marker + ' ');
    notice(`Attached ${marker} — ${read.detail}.`, 'info');
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
      controller.append({ role: 'error', content: `Image paste failed: ${(e as Error).message}` });
    });
  };

  // Open the confirm dialog and wait for its answer. Deferred past the current keypress dispatch:
  // Ink hands the Enter that submitted to every useInput handler, and opening synchronously would
  // let the dialog's own handler see it and answer "send as typed" on the spot. `initial` is the
  // row that starts selected — the /implement picker's default row 0, or the current state's row
  // for the toggle dialogs (#625), so Enter alone changes nothing there.
  const askChoice = (spec: ConfirmSpec, initial = 0): Promise<number | 'abort'> => {
    setConfirmSelected(Math.max(0, Math.min(initial, spec.options.length - 1)));
    return new Promise(resolve => {
      queueMicrotask(() => void controller.openConfirm(spec).then(resolve));
    });
  };

  // Drain the queue once the agent is idle again. Replays messages in order through the normal
  // onSubmit path: image attachments go back onto imageAttachmentsRef, where the markers still in
  // the text select them (hasImageMarker → attachImageBlocks). onSubmit re-seals itself while
  // busy, so a still-busy replay just lands back on the queue.
  useEffect(() => {
    const next = controller.takeQueued({
      resuming: resumingRef.current,
    });
    if (!next) return;
    imageAttachmentsRef.current = next.images ?? [];
    void onSubmit(next.content, next.answers).finally(() => controller.replayDone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, pending, confirm, replaying, preparing, queue]);

  const onSubmit = async (input: string, carried?: SubmitAnswers) => {
    // Left in the box rather than queued: the resume replaces the conversation the prompt was
    // typed against, and the user sees it land before deciding to send.
    if (resumingRef.current) return;
    // An answer being typed for `ask_user` — not a message for the model. Intercepted ahead of the
    // controller's busy queue: a question only exists mid-turn, so every such submit would otherwise
    // be queued as the user's next prompt.
    // A decline's reason, likewise not a message for the model's next turn. An empty one is not a
    // reason; the field stays open, and ctrl-c is the way back to a plain Decline.
    if (controller.approval && approvalTypingRef.current) {
      const text = input.trim();
      if (!text) return;
      setInputValue(preAnswerDraftRef.current);
      setSuggestionState(null);
      setApprovalTyping(false);
      answerApproval({ feedback: text });
      return;
    }
    const q = controller.question;
    const typing = questionTypingRef.current;
    if (q && typing) {
      const text = input.trim();
      // An empty own-answer isn't an answer; leave the box open rather than resolving with nothing.
      // An empty note is fine — it just means "this option, no comment".
      if (typing.forIndex === undefined && !text) return;
      setInputValue('');
      setSuggestionState(null);
      setQuestionTyping(null);
      if (typing.forIndex === undefined) {
        answerQuestion({ text });
      } else {
        answerQuestion({
          text: q.options[typing.forIndex].label,
          index: typing.forIndex,
          ...(text ? { notes: text } : {}),
        });
      }
      return;
    }
    await controller.submit(input, inputFrontEnd(), carried);
  };

  // What a turn the controller runs reports to this front end: the dialogs' cursor resets. The live
  // stream and the per-turn indicators are read off the controller (liveview.ts).
  const turnFrontEnd: TurnFrontEnd = {
    requestApproval,
    requestQuestion,
  };

  // The status line's context gauge: raw window for the ratio, shed ceiling for the percent. Same
  // operands the transcript header freezes at save time, so the two can't disagree.
  const statusProfile = config?.profiles[activeProfile];
  const statusWindow = statusProfile?.contextWindow ?? config?.contextWindow;
  const statusUsable =
    statusWindow && config
      ? Math.round(
          compactThreshold(
            statusWindow,
            sessionRef.current?.config.minGenTokens ??
              statusProfile?.minGenTokens ??
              config.minGenTokens,
          ),
        )
      : undefined;

  const prefilling = prefillLabel(promptProgress ?? undefined);
  const statusWidth = useContentWidth();
  const statusProps: StatusProps = {
    model: config?.profiles[activeProfile]?.model ?? config?.model ?? '',
    turns: messages.filter(m => m.role === 'assistant').length,
    // Null outside a model turn: a shell run or a /cd is busy with no phase of its own.
    status: status === 'busy' ? (phase ?? 'thinking') : status,
    elapsed: status === 'busy' ? elapsed : null,
    usage: withLiveUsage(usage, liveUsage),
    contextTokens: lastUsage?.promptTokens ?? estimatedContext,
    contextWindow: statusWindow,
    contextUsable: statusUsable,
    sheds: shrink.sheds,
    folds: shrink.folds,
    cachedTokens: lastUsage?.cachedTokens,
    decodeRate: liveUsage?.rate ?? decodeRate,
    pr: pr,
    autoApprove:
      config?.autoApprove === 'bypass'
        ? 'bypass'
        : effectiveAutoApprove(config, sessionAutoApprove) === 'safe'
          ? 'safe'
          : undefined,
    unattended: unattended,
    modeTag: mode,
    exitArmed: exitArmed && status === 'idle' && pending === null && inputValue === '',
  };
  // The bar's packing is held where the last frame put it (#948): the volatile chips change width
  // every second, and a fresh re-fit re-flows the lines behind them on every tick. One packing
  // decides both what is drawn and what the frame is budgeted for — see `useStatusLayout`.
  const statusLayout = useStatusLayout(statusProps, statusWidth);
  // Status rows past the one the baseline chrome assumes: a narrow pane (three iTerm2 panes) wraps
  // the bar onto several, and unbudgeted they push the live frame to viewport height, where Ink
  // repaints with a scrollback clear on every chunk.
  const statusExtraRows = Math.max(0, statusLayout.rows - 1);

  // Live rows above a dialog (plan checklist, queued messages, a wrapped status bar) it has to
  // leave viewport room for.
  const dialogReservedRows =
    statusExtraRows +
    (planSteps && (mode === 'agent' || mode === 'vibe') ? planProgressRows(planSteps) : 0) +
    (queue.length > 0 ? queue.length + 1 : 0);

  const holdActive =
    dialogHold !== null &&
    status === 'busy' &&
    pending === null &&
    question === null &&
    (!dialogHold.forCall || runningCall?.since === dialogHold.at);
  const heldRows = holdActive && dialogHold.rows > 0 ? dialogHold.rows : undefined;
  const holdAt = holdActive ? dialogHold.at : undefined;
  // Measured after every frame the dialog is in, so the answer can hold exactly what it drew.
  useEffect(() => {
    if ((pending || question) && heldFrameRef.current) {
      heldFrameRowsRef.current = measureElement(heldFrameRef.current).height;
    }
  });
  useEffect(() => {
    if (dialogHold && !holdActive && pending === null && question === null) setDialogHold(null);
  }, [dialogHold, holdActive, pending, question]);
  // A row committed while the hold is up lands above the held frame and would push the input down
  // by its height (a question's answer row, the round's next message), so the hold gives those rows
  // back. Ink lays out only the rows being committed in this render under its static node; a layout
  // effect's update re-renders inside the same tick, so the two renders paint as one frame.
  useLayoutEffect(() => {
    if (heldRows === undefined) return;
    const root = heldFrameRef.current?.parentNode as { staticNode?: DOMElement } | undefined;
    const committed = root?.staticNode?.yogaNode?.getComputedHeight() ?? 0;
    if (committed > 0) setDialogHold(h => h && { ...h, rows: Math.max(0, h.rows - committed) });
  }, [messages, heldRows]);
  // A short timer of its own, unlike the rest of the live region: the ease is a few frames long,
  // and the status bar's one-second tick is far too coarse to animate it.
  useEffect(() => {
    if (holdAt === undefined) return;
    let timer = setTimeout(function step() {
      const sinceOutput = Date.now() - lastLiveOutputAtRef.current;
      if (lastLiveOutputAtRef.current >= holdAt && sinceOutput < HOLD_QUIET_MS) {
        timer = setTimeout(step, HOLD_QUIET_MS - sinceOutput);
        return;
      }
      const blank = holdSpacerRef.current ? measureElement(holdSpacerRef.current).height : 0;
      setDialogHold(h =>
        h && h.at === holdAt
          ? { ...h, rows: blank > 0 ? h.rows - Math.max(1, Math.ceil(blank * HOLD_EASE)) : 0 }
          : h,
      );
      if (blank > 0) timer = setTimeout(step, HOLD_FRAME_MS);
    }, HOLD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [holdAt, lastLiveOutputAtRef]);

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text>Error</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  if (debugEnabled()) {
    const live = [
      streamingReasoning && 'reasoning',
      streaming && 'content',
      streamingTool && `tool:${streamingToolName}`,
    ].filter(Boolean);
    const dialog = pending
      ? 'approval'
      : question
        ? 'question'
        : modelSelect
          ? 'model'
          : resumeSelect
            ? 'resume'
            : confirm
              ? 'confirm'
              : '-';
    noteFrameState(
      `${status === 'busy' ? phase : status} msgs=${messages.length} live=${live.join(',') || '-'}` +
        ` pending=${pendingTool || '-'} dialog=${dialog} queue=${queue.length}` +
        ` plan=${planSteps ? planSteps.length : 0} suggest=${suggestionState ? 1 : 0}` +
        `${subagentLive ? ' subagent' : ''}${heldRows ? ` held=${heldRows}` : ''}`,
    );
  }

  return (
    <Box ref={heldFrameRef} flexDirection="column" paddingX={1} minHeight={heldRows}>
      <Static items={headerItems}>
        {(h, i) => (
          <Splash key={i} model={h.model} cwd={h.cwd} version={h.version} subagent={h.subagent} />
        )}
      </Static>
      {/* Bootstrap draws nothing but the MCP line: before the session comes up there is no mode, no
          model and no input to describe, so a placeholder would only be noise on the way to the real
          frame. Waiting on a server is the exception — there the frame names what it is waiting for
          (#265). The splash lands here first (headerItems), then everything below it. */}
      {status === 'loading' && loadingNote ? <Text color={theme.muted}>{loadingNote}</Text> : null}
      {status === 'loading' ? null : (
        <>
          <Scrollback
            messages={messages}
            streaming={status === 'busy' ? streaming : ''}
            streamingReasoning={status === 'busy' ? streamingReasoning : ''}
            streamingTool={status === 'busy' ? streamingTool : ''}
            streamingNested={subagentLive}
            streamingCommand={streamingToolName === 'bash'}
            // Hidden while a dialog is up: the approval a tool asks for happens *inside* the call
            // (after the loop announced it), so an "Editing…" row behind the prompt would name work
            // that has not been permitted yet. Same condition the spinner uses.
            pendingTool={
              status === 'busy' && pending === null && question === null ? pendingRow : ''
            }
            // Its age (#585), read here rather than ticked in the Scrollback: the status bar's
            // one-second `elapsed` interval re-renders this component for the whole of a call, so
            // the row's timer advances off that instead of an interval of its own.
            pendingToolMs={pendingRow && runningCall ? Date.now() - runningCall.since : 0}
            pendingCommand={holdActive ? dialogHold.command : undefined}
            streamingNote={noteLive}
            showHeldWorked={status !== 'busy'}
            // Everything the live frame draws besides the stream and the baseline chrome — the
            // suggestion list and queue grow it mid-turn, and unbudgeted they push it to viewport
            // height, where Ink repaints with a scrollback clear on every chunk (#470).
            chromeRows={dialogReservedRows + suggestionRows(suggestionState)}
          />
          {/* An answered approval's held rows (see dialogHold): the slack sits under the live
              stream, so the spinner, checklist and input stay put while output fills it. */}
          {heldRows !== undefined || inputFloor ? <Box ref={holdSpacerRef} flexGrow={1} /> : null}
          {planSteps && (mode === 'agent' || mode === 'vibe') ? (
            <PlanProgress steps={planSteps} />
          ) : null}
          {/* Spinner and queue sit *above* any overlay, not between it and the input: the
              overlay drops its bottom border and the input its top one so the two merge into
              one frame, and anything rendered in that gap lands inside the frame. */}
          {status === 'busy' && pending === null && question === null ? (
            <Working
              // Definite harness actions (typecheck, loop recovery) take priority over the soft spin
              // hint — they're things the harness is actively doing, not a maybe. Prefill outranks
              // recovery (#916): the scrollback already records the recovery, and the wait is longer.
              label={
                typechecking
                  ? 'Typechecking'
                  : (prefilling ??
                    (recovering
                      ? 'Recovering from a loop'
                      : reasoningSpin
                        ? 'Thinking — may be looping (ctrl-c to abort)'
                        : noteLive
                          ? 'Writing compaction note'
                          : subagentLive
                            ? 'Subagent working'
                            : undefined))
              }
              words={config?.workingWords ? WORKING_WORDS : undefined}
              accent={
                typechecking
                  ? theme.info
                  : prefilling
                    ? theme.prefill
                    : recovering || noteLive
                      ? theme.info
                      : reasoningSpin
                        ? theme.warning
                        : subagentLive
                          ? theme.subagent
                          : undefined
              }
            />
          ) : (pasting ?? expanding ?? resuming) ? (
            // Same spinner while idle: a paste, a submit that has to fetch a pasted link, or a
            // resume whose scrollback is still being built is a harness action with a visible
            // wait — it should read like the typecheck gate rather than like the app having
            // stalled.
            <Working label={pasting ?? expanding ?? resuming ?? undefined} accent={theme.info} />
          ) : null}
          <QueuedList queue={queue} />
          {pending ? (
            <Approval
              request={pending}
              selectedIndex={approvalSelected}
              typing={approvalTyping}
              reservedRows={dialogReservedRows}
            />
          ) : question ? (
            <Question
              request={question}
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
          ) : resumeSelect ? (
            <ResumeSelect
              entries={resumeSelect.entries}
              selectedIndex={resumeSelected}
              heading={resumeSelect.heading}
            />
          ) : confirm ? (
            <Confirm spec={confirm} selectedIndex={confirmSelected} />
          ) : null}
          <Input
            // The question dialog is modal only while its list is up; once the user is typing an
            // answer the input has to be live, since it IS the answer field.
            disabled={
              (pending !== null && !approvalTyping) ||
              modelSelect !== null ||
              resumeSelect !== null ||
              confirm !== null ||
              (question !== null && questionTyping === null)
            }
            attachedAbove={
              pending !== null ||
              question !== null ||
              modelSelect !== null ||
              resumeSelect !== null ||
              confirm !== null
            }
            attachedBelow={suggestionState !== null}
            reservedRows={
              question
                ? questionDialogHeight(
                    question,
                    questionTyping,
                    dialogReservedRows,
                    questionSelected,
                  )
                : statusExtraRows
            }
            suggesting={!!suggestionState && suggestionState.items.length > 0}
            history={history}
            mode={mode}
            value={inputValue}
            onChange={onInputChange}
            onSubmit={onSubmit}
            onPasteImage={onPasteImageSafely}
            onPasteText={onPasteText}
            placeholder={
              // A reason that should stop the model has to say so: "tell me the script" read as
              // run-then-tell and drew retries, "don't run anything" did not (decline-terse/-ask).
              approvalTyping
                ? 'e.g. "use pnpm instead", or "don\'t run anything, just tell me …"'
                : mode === 'shell'
                  ? 'Run a shell command'
                  : mode === 'vibe'
                    ? 'Describe a change — it plans first, then implements'
                    : promptPlaceholder()
            }
          />
          {suggestionState ? (
            <Suggestions state={suggestionState} selectedIndex={suggestionSelected} />
          ) : null}
          <Status {...statusProps} layout={statusLayout.lines} />
        </>
      )}
    </Box>
  );
}
