import { canDrain, queueReceipt, takeNext, type QueuedMessage } from './agent/busyqueue.js';
import { modeSide } from './agent/modes.js';
import { autoApproves, effectiveAutoApprove } from './approval.js';
import type { ConfirmSpec } from './ui/dialogspecs.js';
import type { Approvals } from './ui/summary.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  AutoApproveMode,
  Config,
  Message,
  Mode,
  QuestionAnswer,
  QuestionRequest,
} from './types.js';

// The conversation a front end shows, held outside any UI framework (#584): the scrollback of the
// side on screen, the other side's scrollback while it is off screen, the mode, whether a turn is
// running, the prompts waiting for it to end, whatever is waiting on the user, and whether a tool
// has to ask at all. A front end
// renders from `getSnapshot`/`subscribe` and changes them only through these methods, as it does
// with the session — a copy kept in UI state goes stale between a change and the next render.
//
// The session holds the model-facing history; this holds what the user sees, which also carries
// notices, command echoes and shell output and is never folded.

type Side = 'agent' | 'chat';

// `loading` until the session has booted, `error` when it could not.
export type ControllerStatus = 'loading' | 'idle' | 'busy' | 'error';

export type ControllerSnapshot = {
  messages: Message[];
  mode: Mode;
  status: ControllerStatus;
  // Prompts submitted while a turn was running, oldest first.
  queue: QueuedMessage[];
  // A queued prompt has been handed back and its submit has not settled yet.
  replaying: boolean;
  // What is waiting on the user, one of each at most: a tool asking to act, the model asking a
  // question (`ask_user`), and the harness asking before a prompt is sent.
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
  confirm: ConfirmSpec | null;
  // How many tool actions ran and how many were refused, asked about or not.
  approvals: Approvals;
  // The session's own answer to "auto-approve ordinary actions?" and to "is anyone here?". Null
  // until the user sets one, which leaves the config's value in force.
  sessionAutoApprove: boolean | null;
  sessionUnattended: boolean | null;
};

export type Controller = {
  getSnapshot(): ControllerSnapshot;
  subscribe(listener: () => void): () => void;
  // The same values as the snapshot, for a caller that is not rendering.
  readonly messages: Message[];
  readonly mode: Mode;
  readonly status: ControllerStatus;
  setStatus(status: ControllerStatus): void;
  // Holds a prompt until the running turn ends, and prints its receipt.
  enqueue(message: QueuedMessage): void;
  // The next queued prompt to replay, or null while the queue has to wait. The caller submits it
  // and calls `replayDone` once that submit settles; nothing else is handed out until then.
  takeQueued(blockers: { resuming: boolean }): QueuedMessage | null;
  replayDone(): void;
  readonly approval: ApprovalRequest | null;
  readonly question: QuestionRequest | null;
  readonly confirm: ConfirmSpec | null;
  // The approval gate a turn is run with (#526, approval.ts): an ordinary action runs unasked
  // under `safe`, an unattended session declines what would have asked, and anything else goes on
  // screen and resolves when `answerApproval` is called. Every outcome is counted.
  requestApproval(request: ApprovalRequest): Promise<ApprovalAnswer>;
  // `always` is the "Always (this session)" answer: it also turns the session's auto-approve on.
  // An answer with nothing open is ignored, here and below.
  answerApproval(answer: ApprovalAnswer, opts?: { always?: boolean }): void;
  // The mode the gate is running under: the env's when it forces one, else the session's toggle,
  // else the config's default.
  readonly autoApprove: AutoApproveMode;
  readonly unattended: boolean;
  setSessionAutoApprove(on: boolean | null): void;
  setSessionUnattended(on: boolean | null): void;
  // What an unattended session declined since this was last called.
  takeUnattendedDeclines(): ApprovalRequest[];
  resetApprovals(): void;
  // Null is the question dropped unanswered.
  openQuestion(request: QuestionRequest): Promise<QuestionAnswer | null>;
  answerQuestion(answer: QuestionAnswer | null): void;
  // The chosen row, or 'abort' for the dialog dismissed with nothing chosen.
  openConfirm(spec: ConfirmSpec): Promise<number | 'abort'>;
  answerConfirm(choice: number | 'abort'): void;
  append(...messages: Message[]): void;
  // Puts a new scrollback on screen in place of the current one.
  replace(messages: Message[]): void;
  // Changes the mode and nothing else: the scrollback and the session's side stay as they are.
  setMode(mode: Mode): void;
  // A mode switch the user made. Crossing the chat boundary puts the current scrollback away and
  // brings the other side's back; `trailing` lands after it either way.
  transition(mode: Mode, trailing?: Message[]): void;
  // Both sides' scrollbacks, whichever one is on screen.
  sides(): Record<Side, Message[]>;
  // Sets the scrollback kept off screen, dropping whatever was there.
  stash(side: Side, messages: Message[]): void;
  clearStash(): void;
};

export function createController(opts: {
  mode: Mode;
  // Moves the session's model history to the other side when a transition crosses the boundary.
  switchSide: (side: Side) => void;
  // The session's config, or null before it has booted. Read at each use, never kept.
  config: () => Pick<Config, 'autoApprove' | 'autoApproveExplicit' | 'unattended'> | null;
}): Controller {
  let snapshot: ControllerSnapshot = {
    messages: [],
    mode: opts.mode,
    status: 'loading',
    queue: [],
    replaying: false,
    approval: null,
    question: null,
    confirm: null,
    approvals: { approved: 0, declined: 0 },
    sessionAutoApprove: null,
    sessionUnattended: null,
  };
  let unattendedDeclines: ApprovalRequest[] = [];
  let resolveApproval: ((answer: ApprovalAnswer) => void) | null = null;
  let resolveQuestion: ((answer: QuestionAnswer | null) => void) | null = null;
  let resolveConfirm: ((choice: number | 'abort') => void) | null = null;
  let stashed: Partial<Record<Side, Message[]>> = {};
  const listeners = new Set<() => void>();

  const set = (next: Partial<ControllerSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const counted = (approved: boolean): Approvals => ({
    approved: snapshot.approvals.approved + (approved ? 1 : 0),
    declined: snapshot.approvals.declined + (approved ? 0 : 1),
  });
  const autoApprove = (): AutoApproveMode =>
    effectiveAutoApprove(opts.config(), snapshot.sessionAutoApprove);
  const unattended = (): boolean =>
    snapshot.sessionUnattended ?? opts.config()?.unattended === true;

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get messages() {
      return snapshot.messages;
    },
    get mode() {
      return snapshot.mode;
    },
    get status() {
      return snapshot.status;
    },
    setStatus: status => {
      if (status !== snapshot.status) set({ status });
    },
    enqueue: message =>
      set({
        queue: [...snapshot.queue, message],
        messages: [
          ...snapshot.messages,
          { role: 'system', content: queueReceipt(message), tone: 'info' },
        ],
      }),
    takeQueued: blockers => {
      // A replay under an approval or a confirm could open a second dialog over it. A question
      // only exists while a turn runs, which already holds the queue.
      const drainable = canDrain({
        idle: snapshot.status === 'idle',
        replaying: snapshot.replaying,
        dialogOpen: snapshot.approval !== null || snapshot.confirm !== null,
        ...blockers,
      });
      const taken = drainable ? takeNext(snapshot.queue) : null;
      if (!taken) return null;
      set({ queue: taken.rest, replaying: true });
      return taken.next;
    },
    replayDone: () => {
      if (snapshot.replaying) set({ replaying: false });
    },
    get approval() {
      return snapshot.approval;
    },
    get question() {
      return snapshot.question;
    },
    get confirm() {
      return snapshot.confirm;
    },
    requestApproval: request => {
      // `bypass` never reaches here: a front end in that mode runs a turn with no gate at all.
      if (autoApproves(autoApprove(), request)) {
        set({ approvals: counted(true) });
        return Promise.resolve(true);
      }
      // A dialog nobody answers stalls the turn until morning, so it is declined the way headless
      // declines; the tool's own summary says why.
      if (unattended()) {
        unattendedDeclines.push(request);
        set({ approvals: counted(false) });
        return Promise.resolve(false);
      }
      return new Promise(resolve => {
        resolveApproval = resolve;
        set({ approval: request });
      });
    },
    answerApproval: (answer, { always = false } = {}) => {
      const resolve = resolveApproval;
      if (!resolve) return;
      resolveApproval = null;
      set({
        approval: null,
        approvals: counted(answer === true),
        ...(always ? { sessionAutoApprove: true } : {}),
      });
      resolve(answer);
    },
    get autoApprove() {
      return autoApprove();
    },
    get unattended() {
      return unattended();
    },
    setSessionAutoApprove: on => {
      if (on !== snapshot.sessionAutoApprove) set({ sessionAutoApprove: on });
    },
    setSessionUnattended: on => {
      if (on !== snapshot.sessionUnattended) set({ sessionUnattended: on });
    },
    takeUnattendedDeclines: () => {
      const taken = unattendedDeclines;
      unattendedDeclines = [];
      return taken;
    },
    resetApprovals: () => set({ approvals: { approved: 0, declined: 0 } }),
    openQuestion: request =>
      new Promise(resolve => {
        resolveQuestion = resolve;
        set({ question: request });
      }),
    answerQuestion: answer => {
      const resolve = resolveQuestion;
      if (!resolve) return;
      resolveQuestion = null;
      set({ question: null });
      resolve(answer);
    },
    openConfirm: spec =>
      new Promise(resolve => {
        resolveConfirm = resolve;
        set({ confirm: spec });
      }),
    answerConfirm: choice => {
      const resolve = resolveConfirm;
      if (!resolve) return;
      resolveConfirm = null;
      set({ confirm: null });
      resolve(choice);
    },
    append: (...messages) => {
      if (messages.length > 0) set({ messages: [...snapshot.messages, ...messages] });
    },
    replace: messages => set({ messages }),
    setMode: mode => {
      if (mode !== snapshot.mode) set({ mode });
    },
    transition: (mode, trailing = []) => {
      const from = modeSide(snapshot.mode);
      const to = modeSide(mode);
      if (from === to) {
        set({
          mode,
          ...(trailing.length > 0 ? { messages: [...snapshot.messages, ...trailing] } : {}),
        });
        return;
      }
      stashed[from] = snapshot.messages;
      // The trailing banner and echo are UI-only, so the model history comes back bare.
      opts.switchSide(to);
      set({ messages: [...(stashed[to] ?? []), ...trailing], mode });
    },
    sides: () => {
      const onScreen = modeSide(snapshot.mode);
      const other: Side = onScreen === 'chat' ? 'agent' : 'chat';
      return { [onScreen]: snapshot.messages, [other]: stashed[other] ?? [] } as Record<
        Side,
        Message[]
      >;
    },
    stash: (side, messages) => {
      stashed = { [side]: messages };
    },
    clearStash: () => {
      stashed = {};
    },
  };
}
