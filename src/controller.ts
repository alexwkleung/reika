import { canDrain, queueReceipt, takeNext, type QueuedMessage } from './agent/busyqueue.js';
import { modeSide } from './agent/modes.js';
import { autoApproves, effectiveAutoApprove } from './approval.js';
import { inheritProfile, modeSwitchProfile } from './config.js';
import { persistableMode, type LastState } from './laststate.js';
import type { Session } from './session.js';
import { countRealTurns, modelHistoryFromScrollback, type SessionSides } from './store/sessions.js';
import { buildModelTargets, type ModelTarget } from './ui/models.js';
import type { ConfirmSpec } from './ui/dialogspecs.js';
import type { Approvals } from './ui/summary.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  AutoApproveMode,
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
  // Null is the question dropped unanswered.
  openQuestion(request: QuestionRequest): Promise<QuestionAnswer | null>;
  answerQuestion(answer: QuestionAnswer | null): void;
  // The chosen row, or 'abort' for the dialog dismissed with nothing chosen.
  openConfirm(spec: ConfirmSpec): Promise<number | 'abort'>;
  answerConfirm(choice: number | 'abort'): void;
  append(...messages: Message[]): void;
  // Puts a new scrollback on screen in place of the current one.
  replace(messages: Message[]): void;
  // Changes the mode without touching the scrollback or the session's side. Like every mode
  // change it is remembered for the next launch and brings the mode's own model with it.
  setMode(mode: Mode): void;
  // A mode switch the user made. Crossing the chat boundary puts the current scrollback away and
  // brings the other side's back; `trailing` lands after it either way.
  transition(mode: Mode, trailing?: Message[]): void;
  // The session, once it has booted. `own` is the profile it opened on, which a mode with no
  // model of its own comes back to.
  readonly session: Session | null;
  attachSession(session: Session, own: string): void;
  // `/model <name>` and the picker's choice: a profile, one of the config's models, or any other
  // name, which is tried on the active profile's server. It pins the session to that model and
  // is what the next launch resumes on.
  pickModel(typed: string, echo?: Message): void;
  // What the model picker and `/model` completion list.
  modelTargets(): ModelTarget[];
  // When this conversation began: launch, or the last `newConversation`.
  readonly startedAt: number;
  // `/new`: drops both sides and everything the session learned about the engine, and starts over
  // in agent mode on the default profile with the counters, the auto-approve toggle and the model
  // pick cleared. The scrollback is seeded with the echo and a receipt, since an empty screen
  // reads as a fresh launch.
  newConversation(echo: Message): void;
  // Puts a saved session in this one's place and hands back the rows to show: the side that is
  // now on screen, then a receipt. The caller shows them, in slices if it wants, starting with a
  // `replace`. A session with only one side opens on that side (#875).
  loadConversation(sides: SessionSides, from: { title?: string; path: string }): Message[];
  // Both sides' scrollbacks, whichever one is on screen.
  sides(): Record<Side, Message[]>;
};

export function createController(opts: {
  mode: Mode;
  // Saves what the next launch opens on (#365): a mode the user switched to, a model they picked.
  // Every front end hands in the same one, so a session started in one resumes in another.
  remember: (state: LastState) => void;
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
  let session: Session | null = null;
  // The model a mode switch comes back to when the new mode has none of its own (#616): the
  // profile the session opened on, or 'default' once the model is unpinned.
  let ownProfile = 'default';
  // The user said which model this session runs, which outranks the per-mode map (#616).
  let modelPinned = false;
  let startedAt = Date.now();
  const listeners = new Set<() => void>();

  const set = (next: Partial<ControllerSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const counted = (approved: boolean): Approvals => ({
    approved: snapshot.approvals.approved + (approved ? 1 : 0),
    declined: snapshot.approvals.declined + (approved ? 0 : 1),
  });
  const config = () => session?.getSnapshot().config ?? null;
  const autoApprove = (): AutoApproveMode =>
    effectiveAutoApprove(config(), snapshot.sessionAutoApprove);
  const unattended = (): boolean => snapshot.sessionUnattended ?? config()?.unattended === true;
  const append = (...messages: Message[]): void => {
    if (messages.length > 0) set({ messages: [...snapshot.messages, ...messages] });
  };

  // `picked` is the user's own choice, which pins the session to it and is remembered. A switch
  // a mode makes is neither: its model is re-derived from REIKA_MODE_MODELS at every launch, and
  // saving it would strand the next session there after the map changed.
  const switchModel = (target: string, echo: Message | undefined, picked: boolean): void => {
    const cfg = config();
    const next = cfg?.profiles[target];
    if (!session || !cfg || !next) return;
    const kind = cfg.models.map(m => m.toLowerCase()).includes(target) ? 'model' : 'profile';
    // Not awaited: the switch is instant, and a turn submitted before the window probe (#417)
    // answers runs without a window, as it would have anyway.
    void session.setProfile(target).then(notices => append(...notices));
    if (picked) {
      modelPinned = true;
      opts.remember({ profile: target });
    }
    append(...(echo ? [echo] : []), {
      role: 'system',
      content: next.adhoc
        ? `Switched to model '${next.model}' — not in your config; using it anyway on ${next.baseURL}`
        : `Switched to ${kind} '${target}' (${next.model})`,
    });
  };
  // A mode without a model of its own comes back to the session's, so plan → agent is a round
  // trip. Nothing moves for a pinned model or for shell, which reaches no model.
  const applyModeModel = (): void => {
    const cfg = config();
    if (!session || !cfg || modelPinned) return;
    const target = modeSwitchProfile(cfg, snapshot.mode, ownProfile);
    if (!target || target === session.profile || !cfg.profiles[target]) return;
    switchModel(target, undefined, false);
  };
  const setMode = (mode: Mode): void => {
    if (mode === snapshot.mode) return;
    set({ mode });
    modeChanged();
  };
  // Every route to a new mode ends here, so the saved state and the mode's model cannot miss one.
  // Chat and shell are not modes a session can open in, so they leave the last work mode saved.
  const modeChanged = (): void => {
    const persisted = persistableMode(snapshot.mode);
    if (persisted) opts.remember({ mode: persisted });
    applyModeModel();
  };

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
    append,
    replace: messages => set({ messages }),
    setMode,
    transition: (mode, trailing = []) => {
      const changed = mode !== snapshot.mode;
      const from = modeSide(snapshot.mode);
      const to = modeSide(mode);
      if (from === to) {
        set({
          mode,
          ...(trailing.length > 0 ? { messages: [...snapshot.messages, ...trailing] } : {}),
        });
      } else {
        stashed[from] = snapshot.messages;
        // The trailing banner and echo are UI-only, so the model history comes back bare.
        session?.switchSide(to);
        set({ messages: [...(stashed[to] ?? []), ...trailing], mode });
      }
      if (changed) modeChanged();
    },
    get session() {
      return session;
    },
    attachSession: (attached, own) => {
      session = attached;
      ownProfile = own;
    },
    pickModel: (typed, echo) => {
      const cfg = config();
      if (!session || !cfg) return;
      const key = typed.trim().toLowerCase();
      if (cfg.profiles[key]) return switchModel(key, echo, true);
      // A config model can lack a profile of its own only in the single-model case, where its
      // switch target is 'default', as `buildModelTargets` maps it.
      if (cfg.models.some(m => m.toLowerCase() === key)) return switchModel('default', echo, true);
      // A name not in the config still switches (#96): trying a model that is up on the current
      // server should not need a .env edit. It becomes an ad-hoc profile on the active profile's
      // connection, keyed lowercase like every profile, with the model string as typed.
      const inherit = cfg.profiles[session.profile] ?? cfg.profiles.default;
      session.addProfile(key, inheritProfile(inherit, typed.trim()));
      switchModel(key, echo, true);
    },
    modelTargets: () => {
      const cfg = config();
      return session && cfg ? buildModelTargets(cfg, session.profile) : [];
    },
    get startedAt() {
      return startedAt;
    },
    newConversation: echo => {
      stashed = {};
      startedAt = Date.now();
      set({
        messages: [
          echo,
          { role: 'system', content: 'New session — conversation, tokens, and mode reset.' },
        ],
        approvals: { approved: 0, declined: 0 },
        sessionAutoApprove: null,
      });
      // Also drops back to the default profile, which may be another model on other hardware.
      session?.reset({ relearn: true });
      session?.switchSide('agent');
      // A picked model belonged to the conversation that just went away. Unpinned before the mode
      // moves: the mode's model is applied over `ownProfile`, which must already be the default.
      modelPinned = false;
      ownProfile = 'default';
      setMode('agent');
      applyModeModel();
    },
    loadConversation: (sides, from) => {
      stashed = {};
      session?.reset({ relearn: false });
      // Emptied first so a line the mode change prints below can be told from the old scrollback.
      set({ messages: [] });
      const agentTurns = countRealTurns(sides.agent);
      const chatTurns = countRealTurns(sides.chat);
      // Leaving chat goes to agent, not the saved session's last mode, which could be plan or
      // shell. Nothing is on screen to put away, so only the session's side and the mode move.
      const switchedTo: Mode | null =
        snapshot.mode !== 'chat' && agentTurns === 0 && chatTurns > 0
          ? 'chat'
          : snapshot.mode === 'chat' && chatTurns === 0 && agentTurns > 0
            ? 'agent'
            : null;
      if (switchedTo) {
        session?.switchSide(modeSide(switchedTo));
        setMode(switchedTo);
      }
      const onScreen = modeSide(snapshot.mode);
      const offScreen: Side = onScreen === 'chat' ? 'agent' : 'chat';
      const active = sides[onScreen];
      const other = sides[offScreen];
      stashed = { [offScreen]: other };
      session?.loadHistory(modelHistoryFromScrollback(active), modelHistoryFromScrollback(other));
      const otherNote = other.length > 0 ? ` (+ ${other.length} on the ${offScreen} side)` : '';
      return [
        ...active,
        {
          role: 'system',
          content: `Resumed "${from.title ?? 'untitled'}" — ${active.length} ${onScreen} messages${otherNote}${switchedTo ? `, switched to ${switchedTo} mode,` : ''} from ${from.path}`,
        },
        // What the mode change printed: the model it brought, which belongs under the receipt.
        ...snapshot.messages,
      ];
    },
    sides: () => {
      const onScreen = modeSide(snapshot.mode);
      const other: Side = onScreen === 'chat' ? 'agent' : 'chat';
      return { [onScreen]: snapshot.messages, [other]: stashed[other] ?? [] } as Record<
        Side,
        Message[]
      >;
    },
  };
}
