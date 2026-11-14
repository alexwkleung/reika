import type { ImageAttachment, NativeImage } from './agent/attachments.js';
import {
  canDrain,
  queuedMessage,
  queueReceipt,
  takeNext,
  type QueuedMessage,
  type SubmitAnswers,
} from './agent/busyqueue.js';
import { buildLaunchNotices } from './agent/launchnotices.js';
import type { ShrinkCounts } from './agent/loop.js';
import { modeSide, resolveModeCommand, turnMode, turnTools } from './agent/modes.js';
import { resolveReplyCommand, unknownCommandText } from './agent/replycommands.js';
import {
  buildShellRunsBlock,
  captureShellRun,
  holdShellRun,
  shellRunBudget,
  type ShellRun,
} from './agent/shellruns.js';
import {
  buildSubmitInput,
  skillToConfirm,
  urlsToConfirm,
  type SubmitStage,
} from './agent/submitinput.js';
import {
  resolveToggleCommand,
  toggleReceipt,
  type ToggleCommand,
  type ToggleName,
} from './agent/togglecommands.js';
import {
  IMPLEMENT_MODES,
  isImplementCommand,
  parseCommand,
  resolveSkillCommand,
  resolveTurnCommand,
  type ImplementMode,
  type TurnCommand,
} from './agent/turncommands.js';
import {
  autoApproveForced,
  autoApproves,
  effectiveAutoApprove,
  formatUnattendedDeclines,
} from './approval.js';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { inheritProfile, modeSwitchProfile, resolveProfile } from './config.js';
import { bootstrap } from './context/bootstrap.js';
import { budgetWarning, formatBudget } from './context/bundlesize.js';
import { addFileToIndex } from './context/files.js';
import { debugLog, processSessionStem } from './debug.js';
import { persistableMode, startProfiles, type LastState } from './laststate.js';
import { invokeMcpTool, parseMcpArgs, type McpCommand } from './mcp/tools.js';
import { createSession as createRealSession, type Session, type SessionEvents } from './session.js';
import {
  countRealTurns,
  forAutosave,
  listSessions,
  modelHistoryFromScrollback,
  newSessionPath,
  projectHistoryDir,
  ROOT_HISTORY_DIR,
  saveHeader,
  writeSession,
  type SessionEntry,
  type SessionSides,
} from './store/sessions.js';
import {
  buildTranscriptMeta,
  saveTranscript as writeTranscript,
  type TranscriptMeta,
  type TranscriptShrinkEvent,
} from './store/transcript.js';
import { execStream } from './tools/bash.js';
import { isOffline } from './tools/_net.js';
import { clearIdentity, enableAnon, isAnon } from './ui/identity.js';
import { isSaveCommand } from './ui/commands.js';
import { expandPastes, type PastedText } from './ui/pastes.js';
import { buildModelTargets, type ModelTarget } from './ui/models.js';
import {
  CONFIRM_ACCEPT,
  implementModeConfirmSpec,
  pastedUrlConfirmSpec,
  skillConfirmSpec,
  TOGGLE_CANCEL,
  TOGGLE_OFF,
  TOGGLE_ON,
  toggleConfirmSpec,
  type ConfirmSpec,
} from './ui/dialogspecs.js';
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
  Usage,
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
const AUTOSAVE_INTERVAL_MS = 3000;

export type ControllerStatus = 'loading' | 'idle' | 'busy' | 'error';

// What `/resume` comes to: sessions to pick from under a heading, or a line saying why not.
export type ResumeList = { entries: SessionEntry[]; heading: string } | { reply: string };

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

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
  // Why the session could not boot, while the status is `error`.
  error: string | null;
  // What the session measured: the token total, the last real request's count, the pre-send
  // estimate that fills the gauge before one lands, the sheds and folds, and the decode rate of the
  // model on now. /stats, the status bar and every saved header read these.
  usage: Usage;
  lastUsage: Usage | null;
  estimatedContext: number | null;
  shrink: ShrinkCounts;
  decodeRate: number | undefined;
};

// One prompt's turn. `mode` is the one turn's override of the controller's mode (/implement flips
// the mode and submits in one tick); `notices` land right after the turn's user bubble, the
// placement the URL grounder follows: a receipt reads as a follow-on to the action, never as an
// announcement in front of it.
export type TurnOptions = {
  display?: string;
  mode?: Mode;
  nativeImages?: NativeImage[];
  manualCompact?: boolean;
  // Stamped on the turn's user message: compaction needs to know its opening tool call was a
  // skill's mandate rather than picked by position (#275), and the content is just the body.
  skill?: string;
  notices?: Message[];
};

// What a front end hears while a turn runs. The live stream is its own state; `onMessage` sees
// each message before it lands in the scrollback. The request wrappers stand in for the
// controller's own dialogs, for a front end that resets a dialog's cursor first.
export type TurnFrontEnd = {
  events?: Omit<SessionEvents, 'onMessage'>;
  onMessage?(msg: Message): void;
  // After the status goes busy, and before it goes idle.
  onTurnStart?(): void;
  onTurnEnd?(): void;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  requestQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer | null>;
};

// A typed prompt's input-box state. `onStage` names what the submit is waiting on, and gets null
// when it stops; `onBuilt` is the images taken by the prompt, which a failed build leaves alone.
export type SubmitPromptInput = {
  answers: SubmitAnswers;
  images: ImageAttachment[];
  pastes: PastedText[];
  onStage(stage: SubmitStage | null): void;
  onBuilt?(): void;
};

// What a front end hands `boot`. The loaders are passed in so a test never reads the developer's
// own config or saved state. `onConfig` runs before the session is awaited, and `onSession` before
// any launch notice lands, so a front end can paint its header in the same tick as the notices.
export type BootInput = {
  cwd: string;
  loadConfig: () => Config;
  lastState: LastState;
  // The mode the env alone would start in; opening in another one is announced.
  defaultMode: Mode;
  onConfig?(config: Config): void;
  onSession?(session: Session, started: { profile: string; own: string }): void;
};

// A shell-mode run's output as it streams, bracketed by its busy spell.
export type ShellFrontEnd = {
  onStart?(): void;
  onProgress(chunk: string): void;
  onEnd?(): void;
};

// What a front end hands `runCommand`: the hooks for the commands that end in a turn, a dialog or
// a picker of its own.
export type CommandFrontEnd = {
  // For a command that ends in a model turn.
  turn: TurnFrontEnd;
  // The paste store, which a skill command's arguments may point into.
  pastes: PastedText[];
  // /implement's answer to "which mode", asked before the command was sent (#561).
  implementMode?: ImplementMode;
  // Opens a dialog the front end's way, with its cursor on `initial`. The controller's own
  // `openConfirm` when absent.
  ask?(spec: ConfirmSpec, initial?: number): Promise<number | 'abort'>;
  exit(): void;
  // Bare /model and /resume: the front end shows its own picker over what the controller lists.
  pickModel(targets: ModelTarget[]): void;
  pickSession(list: { entries: SessionEntry[]; heading: string }): void;
  // /new also drops whatever live state the front end holds.
  onNewConversation?(): void;
};

// What a front end hands `submit` for a typed line: the command hooks, the shell's, and the input
// box's. `images` and `pastes` are read when the line needs them, which is after its questions.
export type InputFrontEnd = Omit<CommandFrontEnd, 'implementMode'> & {
  shell: ShellFrontEnd;
  // The image attachments in the box.
  images: ImageAttachment[];
  onStage: SubmitPromptInput['onStage'];
  // The box's attachments went with the line: built into its prompt, or queued with it.
  onImagesTaken?(): void;
  // A line is about to run now, before its questions: a speculative warm of the prefix is stopped
  // so the real request gets the server's slot.
  onSending?(): void;
  // The line was taken and the box should clear. `line` goes into input history, and is absent for
  // a queued or an empty line, which is not recalled.
  onTaken(line?: string): void;
  // Just before /implement's mode question opens, for whatever the typed command left open.
  beforeImplementQuestion?(): void;
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
  // `/approvals`, `/unattended` or `/anon` as typed (agent/togglecommands.ts): a line to print, a
  // pick to ask the user for, or a switch to flip. Null for any other command.
  toggleCommand(name: string, args: string): ToggleCommand | null;
  // Flips one of the three switches and prints its receipt under `echo`.
  setToggle(toggle: ToggleName, on: boolean, echo?: Message): Promise<void>;
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
  // Loads the config, opens the session on the profile the last session and the start mode's own
  // model (#616) give, and prints the launch notices. Idle and the session on success; on any
  // failure, `error` with its message in the snapshot and null.
  boot(input: BootInput): Promise<Session | null>;
  // Hands over a session built elsewhere; `boot` ends here.
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
  // The file this conversation auto-saves to (#1), or null before its first save and after a
  // `newConversation`. Fixed once set, so a conversation is one entry in the resume list.
  readonly sessionPath: string | null;
  // Writes the conversation now and resolves when that write, and any before it, has landed.
  // The controller also saves on its own: when a real prompt first appears, whenever a turn or a
  // command ends, and at most every few seconds while a turn runs.
  saveNow(): Promise<void>;
  // `/cd <path>`: re-indexes the project at `target` (relative to the current one, `~` expanded)
  // and moves the session there. Busy while it runs; a failure leaves the session where it was.
  changeDirectory(target: string, echo: Message): Promise<void>;
  // `/save`: writes the scrollback on screen to the history root as a transcript, redacted unless
  // `raw`. Works mid-turn (#226), where it holds everything up to the last finished round.
  saveTranscript(raw: boolean, echo: Message): Promise<void>;
  // `/resume [all|root]`: the sessions to offer, the one in progress left out. Chat mode lists
  // chats (#875), and a project with nothing to list falls back to the manual saves.
  resumeList(args: string): Promise<ResumeList>;
  // Runs one prompt through the session as the controller's mode (or `opts.mode`) and hands back
  // what it emitted, or nothing before the session has booted. Busy for each loop turn it runs
  // (vibe runs two), each with its own abort; under `bypass` there is no approval gate at all.
  runTurn(text: string, opts: TurnOptions, front: TurnFrontEnd): Promise<Message[]>;
  // A typed prompt, after its questions are answered: expanded (mentions, images, pasted links, a
  // routed skill), with the shell runs since the last prompt in front of it, then run. A second
  // prompt while the first is still expanding is dropped.
  submitPrompt(text: string, input: SubmitPromptInput, front: TurnFrontEnd): Promise<void>;
  // A shell-mode command: raw bash, no model. Echoed and shown, and held for the next prompt,
  // which is how the model sees it.
  runShell(command: string, front: ShellFrontEnd): Promise<void>;
  // A slash-invoked MCP tool (#265), shown as a shell message and never in the model history.
  runMcpCommand(raw: string, command: McpCommand, args: string): Promise<void>;
  // Stops the turn, shell command or MCP call that is running. False when nothing was.
  abort(): boolean;
  // A typed `/command`, decided in a fixed order: /new, /exit, the commands that only print, the
  // mode commands, the ones that end in a turn, /cd, /resume, /save, the toggles, /model, an MCP
  // tool, then a skill. Each is echoed in the scrollback, except where its turn's own bubble is
  // the echo.
  runCommand(raw: string, front: CommandFrontEnd): Promise<void>;
  // A line typed into the input box. A mid-turn /save runs at once (#226). Otherwise its questions
  // are asked now, whether it runs now or is queued behind a running turn (or a boot), since the
  // replay may run with nobody at the desk; `carried` is a replayed entry's answers, and only a
  // question that never came up then is asked. A dismissed question drops the line and leaves it
  // in the box. Then it is a command, a shell command or a prompt.
  submit(input: string, front: InputFrontEnd, carried?: SubmitAnswers): Promise<void>;
};

export function createController(opts: {
  mode: Mode;
  // Saves what the next launch opens on (#365): a mode the user switched to, a model they picked.
  // Every front end hands in the same one, so a session started in one resumes in another.
  remember: (state: LastState) => void;
  // Where sessions are kept; the default is the user's history directory.
  historyRoot?: string;
  createSession?: typeof createRealSession;
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
    error: null,
    usage: { promptTokens: 0, completionTokens: 0 },
    lastUsage: null,
    estimatedContext: null,
    shrink: { sheds: 0, folds: 0 },
    decodeRate: undefined,
  };
  // The events behind the shrink counts, for the saved header only: a shed lands every few rounds
  // on a small window, so as scrollback lines they would be noise.
  let shrinkEvents: TranscriptShrinkEvent[] = [];
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
  let sessionPath: string | null = null;
  // The process's first transcript shares the debug log's name (#761); a later one gets its own.
  let stemClaimed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueued = false;
  // Writes run one after another: two in flight could rename out of order and leave the older
  // snapshot on disk.
  let saveChain: Promise<void> = Promise.resolve();
  let saveFailed = false;
  // The real-turn count a resume loaded. Nothing is written until the conversation grows past it,
  // so opening a session and leaving neither copies a /save file into the project nor re-stamps
  // a project session as the newest.
  let saveHold: number | null = null;
  const historyRoot = opts.historyRoot ?? ROOT_HISTORY_DIR;
  const listeners = new Set<() => void>();
  // Whatever is running: a turn, a shell command or an MCP call.
  let aborter: AbortController | null = null;
  // Shell-mode runs since the last prompt, prepended to the next one (agent/shellruns.ts).
  let heldShellRuns: ShellRun[] = [];
  // A hint the user declined once is noise the second time, and the user who wanted it typed the
  // slash command instead.
  const hintedSkills = new Set<string>();
  // The status is still idle while a prompt expands, which can wait on the network for a pasted
  // link, so a second Enter would otherwise start a second turn.
  let submitting = false;

  const set = (next: Partial<ControllerSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
    // Only these two changes mean there is news to save.
    if ('messages' in next || 'status' in next) saveSoon();
  };
  const bothSides = (): Record<Side, Message[]> => {
    const onScreen = modeSide(snapshot.mode);
    const other: Side = onScreen === 'chat' ? 'agent' : 'chat';
    return { [onScreen]: snapshot.messages, [other]: stashed[other] ?? [] } as Record<
      Side,
      Message[]
    >;
  };
  const projectDir = (): string | null =>
    session ? projectHistoryDir(session.bundle.cwd, opts.historyRoot) : null;
  // The basename only: enough to find the transcript under history/, no home path in the log.
  const logSessionFile = (path: string): void =>
    debugLog(`[reika:debug] session file=${basename(path)}`);
  const stopSaveTimer = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  };
  const saveNow = (): Promise<void> => {
    stopSaveTimer();
    const dir = projectDir();
    if (!session || !dir || !session.getSnapshot().config.autosave) return saveChain;
    const all = bothSides();
    const saved = { agent: forAutosave(all.agent), chat: forAutosave(all.chat) };
    const turns = countRealTurns(saved.agent) + countRealTurns(saved.chat);
    // Nothing typed yet: the launch notices alone are not a session worth listing.
    if (turns === 0 || turns <= (saveHold ?? 0)) return saveChain;
    saveHold = null;
    if (sessionPath === null) {
      const stem = stemClaimed ? undefined : processSessionStem();
      stemClaimed = true;
      sessionPath = newSessionPath(dir, new Date(), stem);
      logSessionFile(sessionPath);
    }
    const path = sessionPath;
    const meta = transcriptMeta(session, saved.agent, snapshot.status === 'busy');
    saveChain = saveChain
      .then(() => writeSession(path, saved, meta))
      .catch((e: unknown) => {
        // Said once: a full disk fails every save the same way, and the session itself is fine.
        if (saveFailed) return;
        saveFailed = true;
        append({
          role: 'system',
          tone: 'warn',
          content: `auto-save failed: ${(e as Error).message} — /resume won't have this session; /save still works.`,
        });
      });
    return saveChain;
  };
  // At once on the first real prompt (a session exists from the moment it is typed) and whenever
  // nothing is running; while a turn runs, at most once per interval, so a crash loses seconds of
  // a long turn without a write per round. One decision per tick, however many changes it held.
  const saveSoon = (): void => {
    if (saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => {
      saveQueued = false;
      if (!session?.getSnapshot().config.autosave) return;
      if (snapshot.status !== 'busy' || sessionPath === null) {
        void saveNow();
        return;
      }
      saveTimer ??= setTimeout(() => {
        saveTimer = null;
        void saveNow();
      }, AUTOSAVE_INTERVAL_MS);
    });
  };
  // What `newConversation` and a resume both drop beside the conversation itself.
  const freshMeasurements = (): Partial<ControllerSnapshot> => {
    shrinkEvents = [];
    return {
      usage: { promptTokens: 0, completionTokens: 0 },
      lastUsage: null,
      estimatedContext: null,
      shrink: { sheds: 0, folds: 0 },
    };
  };
  // The header both /save and the auto-save write; `msgs` is what the file's body holds. The
  // active profile's model and server, so it names what was actually running, not the default.
  const transcriptMeta = (s: Session, msgs: Message[], midTurn: boolean): TranscriptMeta => {
    const cfg = s.getSnapshot().config;
    const profile = cfg.profiles[s.profile] ?? cfg.profiles.default;
    return buildTranscriptMeta({
      msgs,
      model: profile.model,
      baseURL: profile.baseURL,
      cwd: s.bundle.cwd,
      mode: snapshot.mode,
      midTurn,
      status: {
        totals: snapshot.usage,
        lastUsage: snapshot.lastUsage,
        estimatedContext: snapshot.estimatedContext,
        shrink: s.shrink,
        shrinkEvents,
        contextWindow: profile.contextWindow ?? cfg.contextWindow,
        // The session's reserve is the learned one (#551), the number the next round compacts at.
        minGenTokens: s.config.minGenTokens ?? profile.minGenTokens,
      },
    });
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
    // The tok/s chip describes the model that produced it (#204), so it goes with any switch: one
    // the user picked or one a mode change brought.
    if (snapshot.decodeRate !== undefined) set({ decodeRate: undefined });
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

  const requestApproval = (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    // `bypass` never reaches here: a turn in that mode runs with no gate at all.
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
  };
  const openQuestion = (request: QuestionRequest): Promise<QuestionAnswer | null> =>
    new Promise(resolve => {
      resolveQuestion = resolve;
      set({ question: request });
    });
  const openConfirm = (spec: ConfirmSpec): Promise<number | 'abort'> =>
    new Promise(resolve => {
      resolveConfirm = resolve;
      set({ confirm: spec });
    });
  const setStatus = (status: ControllerStatus): void => {
    if (status !== snapshot.status) set({ status });
  };

  const attachSession = (attached: Session, own: string): void => {
    session = attached;
    ownProfile = own;
  };
  const createSession = opts.createSession ?? createRealSession;
  const boot = async (input: BootInput): Promise<Session | null> => {
    try {
      const cfg = input.loadConfig();
      // Resolved before the session is created so the window probe and the splash describe the
      // model it actually opens on.
      const started = startProfiles(cfg, snapshot.mode, input.lastState);
      input.onConfig?.(cfg);
      // Unattended (#526): ask_user would open a dialog nobody answers, so it is not offered.
      const s = await createSession({
        cwd: input.cwd,
        config: cfg,
        profile: started.profile,
        canAsk: !cfg.unattended,
      });
      attachSession(s, started.own);
      input.onSession?.(s, started);
      // Startup only: a later /model switch reports its own window in /stats.
      const runtime = s.config;
      // The window/reserve arithmetic goes to the log always; the scrollback hears of it only
      // under the floor (#262).
      debugLog(formatBudget(s.bundle, runtime));
      append(
        ...buildLaunchNotices({
          facts: {
            model: runtime.model,
            limitsNotice: s.limitsNotice,
            windowNotice: s.windowNotice,
            budgetWarning: budgetWarning(s.bundle, runtime),
            offline: s.offline,
            searchNotice: s.searchNotice,
            mcpNotices: s.mcpNotices,
          },
          config: cfg,
          mode: snapshot.mode,
          defaultMode: input.defaultMode,
          profile: started.profile,
        }),
      );
      setStatus('idle');
      return s;
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
      return null;
    }
  };

  const runTurn = async (
    text: string,
    turn: TurnOptions,
    front: TurnFrontEnd,
  ): Promise<Message[]> => {
    const s = session;
    const cfg = config();
    if (!s || !cfg) return [];
    let notices = turn.notices ?? [];
    const activeMode = turn.mode ?? snapshot.mode;
    return s.submit(text, {
      mode: activeMode,
      // What this turn is recorded as on its prompt, which is not always what it runs as.
      recordAs: turnMode(snapshot.mode, activeMode),
      display: turn.display,
      skill: turn.skill,
      nativeImages: turn.nativeImages,
      manualCompact: turn.manualCompact,
      requestApproval:
        cfg.autoApprove === 'bypass' ? undefined : (front.requestApproval ?? requestApproval),
      requestQuestion: front.requestQuestion ?? openQuestion,
      isUnattended: unattended,
      onTurnStart: () => {
        setStatus('busy');
        front.onTurnStart?.();
        aborter = new AbortController();
        return aborter.signal;
      },
      onTurnError: e => {
        append({ role: 'error', content: e.message });
      },
      onTurnEnd: () => {
        // After the final reply, so a glance at the end of a night's scrollback shows what is left.
        const declined = formatUnattendedDeclines(unattendedDeclines.splice(0));
        if (declined) append({ role: 'system', content: declined, tone: 'warn' });
        front.onTurnEnd?.();
        setStatus('idle');
        aborter = null;
      },
      events: {
        ...front.events,
        onUsage: u => {
          const t = snapshot.usage;
          set({
            // The gauge and cache chip read lastUsage, and an estimate has no real count for either.
            ...(u.estimated ? {} : { lastUsage: u }),
            usage: {
              promptTokens: t.promptTokens + u.promptTokens,
              completionTokens: t.completionTokens + u.completionTokens,
              ...(u.cachedTokens != null
                ? { cachedTokens: (t.cachedTokens ?? 0) + u.cachedTokens }
                : t.cachedTokens != null
                  ? { cachedTokens: t.cachedTokens }
                  : {}),
              ...(u.estimated || t.estimated ? { estimated: true } : {}),
            },
          });
          front.events?.onUsage?.(u);
        },
        onContextEstimate: tokens => {
          set({ estimatedContext: tokens });
          front.events?.onContextEstimate?.(tokens);
        },
        onShrink: (event, counts) => {
          // The last reported prompt size predates the shed/fold, and the gauge prefers it over
          // the estimate — so /compact, with no request after its fold, kept the pre-fold fill.
          set({ shrink: counts, lastUsage: null });
          // Stamp the turn the way the status line counts turns (assistant messages so far), so
          // the saved event lines up with the `turn N` a reader sees in the header.
          const turnNumber = snapshot.messages.filter(m => m.role === 'assistant').length + 1;
          shrinkEvents = [...shrinkEvents, { turn: turnNumber, ...event }];
          front.events?.onShrink?.(event, counts);
        },
        onDecodeRate: rate => {
          set({ decodeRate: rate });
          front.events?.onDecodeRate?.(rate);
        },
        onMessage: msg => {
          front.onMessage?.(msg);
          if (msg.role === 'tool') {
            // Keeps `@` autocomplete current with files the model writes this turn, so a
            // just-created file is attachable without a restart or /cd. The diff path is relative
            // (write/edit emit `relative(cwd, …)`), matching fileIndex. addFileToIndex no-ops on
            // existing/filtered paths.
            //
            // That relativeness is load-bearing, not incidental: `ignore` throws a RangeError on an
            // absolute path, so an out-of-project write would take the turn down here. write/edit
            // keep a separate `display` string for the user- and model-facing text and never put
            // it on `diff.path`. A bash command's changes qualify the same way, minus deletions and
            // anything that reached outside cwd (`../` is exactly what `ignore` throws on).
            const written = [
              ...(msg.diff?.path ? [msg.diff.path] : []),
              ...(msg.changes?.files ?? [])
                .filter(f => f.kind !== 'deleted' && !f.path.startsWith('..'))
                .map(f => f.path),
            ];
            if (written.length > 0) {
              s.updateBundle(prev => {
                const next = written.reduce(
                  (idx, p) => addFileToIndex(idx, p, prev.ignore),
                  prev.fileIndex,
                );
                return next === prev.fileIndex ? prev : { ...prev, fileIndex: next };
              });
            }
          }
          if (msg.role === 'user' && notices.length > 0) {
            const flushed = notices;
            notices = [];
            append(msg, ...flushed);
            return;
          }
          append(msg);
        },
      },
    });
  };

  // Carries out what a turn command resolved to (agent/turncommands.ts): its lines, the mode
  // switch and the submit. The typed command is the turn's bubble, unless the turn emits no user
  // message and the command is echoed by hand.
  const runTurnCommand = async (
    cmd: TurnCommand,
    raw: string,
    echo: Message,
    front: TurnFrontEnd,
  ): Promise<void> => {
    if (cmd.kind === 'refuse') {
      append(echo, { role: 'system', content: cmd.content });
      return;
    }
    if (cmd.switchTo) setMode(cmd.switchTo);
    const before = cmd.before.map(n => ({ role: 'system' as const, ...n }));
    if (cmd.echo || before.length > 0) {
      append(...(cmd.echo ? [echo] : []), ...before);
    }
    // The override forces this turn's tools + promptMode regardless of a not-yet-flushed mode.
    await runTurn(
      cmd.modelText,
      {
        display: cmd.echo ? undefined : raw,
        mode: cmd.mode,
        manualCompact: cmd.manualCompact,
        skill: cmd.skill,
        notices: cmd.after.map(n => ({ role: 'system' as const, ...n })),
      },
      front,
    );
  };

  const runCommand = async (raw: string, front: CommandFrontEnd): Promise<void> => {
    const { name, args } = parseCommand(raw);
    // `meta` keeps this command echo in the scrollback but out of the model-facing history.
    const echo: Message = { role: 'user', content: raw, meta: true };

    if (name === 'clear' || name === 'new') {
      controller.newConversation(echo);
      front.onNewConversation?.();
      return;
    }
    if (name === 'exit' || name === 'quit') {
      front.exit();
      return;
    }
    // The commands that only print (agent/replycommands.ts).
    const reply = resolveReplyCommand(name, {
      cwd: session?.bundle.cwd,
      skills: session?.bundle.skills ?? [],
      messages: snapshot.messages,
      usage: snapshot.usage,
      startedAt,
      approvals: snapshot.approvals,
      mcpList: () => session?.mcp.list(),
    });
    if (reply !== null) {
      append(echo, { role: 'system', content: reply });
      return;
    }
    // /agent, /plan and the other mode commands (agent/modes.ts).
    const modeCommand = resolveModeCommand(name, {
      mode: snapshot.mode,
      busy: snapshot.status === 'busy',
    });
    if (modeCommand) {
      if (modeCommand.kind === 'refuse') {
        append(echo, { role: 'system', content: modeCommand.content });
      } else {
        controller.transition(modeCommand.to, [
          echo,
          { role: 'system', content: modeCommand.banner },
        ]);
      }
      return;
    }
    // /implement, /compact and /search end in a model turn. Search availability is read off the
    // session's own tool lists rather than re-derived from config, so it agrees with the offline
    // case too — that one is decided once at startup and never revisited.
    const turnCommand = resolveTurnCommand(name, args, {
      mode: snapshot.mode,
      implementMode: front.implementMode,
      searchAvailable: target => {
        const lists = session?.lists;
        return !!lists && turnTools(target, lists).some(t => t.name === 'search');
      },
      offline: isOffline,
    });
    if (turnCommand) {
      await runTurnCommand(turnCommand, raw, echo, front.turn);
      return;
    }
    if (name === 'cd') {
      await controller.changeDirectory(args, echo);
      return;
    }
    if (name === 'resume') {
      const list = await controller.resumeList(args);
      if ('reply' in list) {
        append(echo, { role: 'system', content: list.reply });
        return;
      }
      append(echo);
      front.pickSession(list);
      return;
    }
    if (name === 'save') {
      await controller.saveTranscript(args.trim().toLowerCase() === '--raw', echo);
      return;
    }
    // /approvals, /unattended and /anon (agent/togglecommands.ts). The bare command asks (#625);
    // cancelling changes nothing and leaves the echo as the only record, like a dismissed picker.
    const toggle = controller.toggleCommand(name, args);
    if (toggle) {
      if (toggle.kind === 'reply') {
        append(echo, { role: 'system', content: toggle.content });
        return;
      }
      let on: boolean;
      if (toggle.kind === 'ask') {
        const spec = toggleConfirmSpec({ title: toggle.title, subtitle: toggle.subtitle });
        const initial = toggle.currentlyOn ? TOGGLE_ON : TOGGLE_OFF;
        const choice = await (front.ask ? front.ask(spec, initial) : openConfirm(spec));
        if (choice === 'abort' || choice === TOGGLE_CANCEL) {
          append(echo);
          return;
        }
        on = choice === TOGGLE_ON;
      } else {
        on = toggle.on;
      }
      await controller.setToggle(toggle.toggle, on, echo);
      return;
    }
    if (name === 'model') {
      if (!config()) {
        append(echo, { role: 'system', content: 'config not loaded' });
        return;
      }
      if (args.trim()) {
        controller.pickModel(args, echo);
        return;
      }
      // Bare /model is the picker. The echo lands now so the command shows in the scrollback even
      // if the picker is dismissed.
      const targets = controller.modelTargets();
      append(echo);
      front.pickModel(targets);
      return;
    }
    // An MCP tool (#265) before a skill: the two share one dispatch point, and a command name
    // carries a colon, which no built-in or skill does — the shapes cannot collide.
    const mcpCommand = session?.mcp.commands.find(c => c.name === name);
    if (mcpCommand) {
      await controller.runMcpCommand(raw, mcpCommand, args);
      return;
    }
    // No echo for a skill: unlike the UI-only commands above it runs a real turn, and runTurn
    // emits its own user message rendered from `raw` — the bubble reads `/issue 14` while the
    // model receives the skill body. Pre-appending would double it.
    const skillCommand = resolveSkillCommand(name, args, {
      skills: session?.bundle.skills ?? [],
      mode: snapshot.mode,
      pastes: front.pastes,
    });
    if (skillCommand) {
      await runTurnCommand(skillCommand, raw, echo, front.turn);
      return;
    }
    append(echo, { role: 'system', content: unknownCommandText(name) });
  };

  // The decide* questions resolve to their answer, 'abort' for a dismissed dialog, or undefined
  // when nothing needed asking.
  const ask = (front: InputFrontEnd, spec: ConfirmSpec): Promise<number | 'abort'> =>
    front.ask ? front.ask(spec) : openConfirm(spec);

  // The skill the user's own words route to (#425). A strong match is asked about rather than
  // injected: the user is the classifier, and the keyword matcher's false positives (a prompt
  // that merely opens with the skill's noun) stop costing a turn.
  const decideSkillRoute = async (
    prompt: string,
    front: InputFrontEnd,
  ): Promise<string | null | 'abort' | undefined> => {
    const cfg = config();
    if (!session || !cfg) return undefined;
    // Every model mode but chat asks (#565). Plan mode asks too — its prompt already keeps an
    // applied body from turning into edits.
    const match = skillToConfirm(prompt, {
      skills: session.bundle.skills,
      skillAuto: cfg.skillAuto,
      mode: snapshot.mode,
      contextWindow: cfg.profiles[session.profile]?.contextWindow ?? cfg.contextWindow,
    });
    if (!match) return undefined;
    const choice = await ask(front, skillConfirmSpec(match));
    return choice === 'abort' ? 'abort' : choice === CONFIRM_ACCEPT ? match.skill.name : null;
  };

  // The pasted-link confirm (#448): a URL that is not what the prompt is about — one inside a
  // pasted error, a log line — is asked about rather than fetched, since a GET on a confirm or
  // tracking link has already acted. A URL the prompt IS about (agent/pastedurls.ts's shape gate)
  // needs no dialog.
  const decidePastedUrls = async (
    prompt: string,
    front: InputFrontEnd,
  ): Promise<boolean | 'abort' | undefined> => {
    const cfg = config();
    if (!cfg) return undefined;
    const urls = urlsToConfirm(prompt, { pasteFetch: cfg.pasteFetch, mode: snapshot.mode });
    if (!urls) return undefined;
    const choice = await ask(front, pastedUrlConfirmSpec(urls));
    return choice === 'abort' ? 'abort' : choice === CONFIRM_ACCEPT;
  };

  // Which mode /implement hands the plan to (#561). Asked only from plan mode, where the old answer
  // was always agent; elsewhere /implement stays in (or maps from) the current mode as before.
  const decideImplementMode = async (
    prompt: string,
    front: InputFrontEnd,
  ): Promise<ImplementMode | 'abort' | undefined> => {
    if (snapshot.mode !== 'plan' || !isImplementCommand(prompt)) return undefined;
    front.beforeImplementQuestion?.();
    const choice = await ask(front, implementModeConfirmSpec());
    return choice === 'abort' ? 'abort' : IMPLEMENT_MODES[choice];
  };

  // Every question a line can raise before it is sent, in one order whether it runs now or is
  // queued. Before the expansions, so no fetch precedes the question.
  const askSubmitAnswers = async (
    prompt: string,
    front: InputFrontEnd,
    carried: SubmitAnswers = {},
  ): Promise<SubmitAnswers | 'abort'> => {
    const skill =
      carried.skill !== undefined ? carried.skill : await decideSkillRoute(prompt, front);
    if (skill === 'abort') return 'abort';
    const fetchUrls =
      carried.fetchUrls !== undefined ? carried.fetchUrls : await decidePastedUrls(prompt, front);
    if (fetchUrls === 'abort') return 'abort';
    const implementMode = carried.implementMode ?? (await decideImplementMode(prompt, front));
    if (implementMode === 'abort') return 'abort';
    return {
      ...(skill !== undefined ? { skill } : {}),
      ...(fetchUrls !== undefined ? { fetchUrls } : {}),
      ...(implementMode !== undefined ? { implementMode } : {}),
    };
  };

  const submit = async (
    input: string,
    front: InputFrontEnd,
    carried?: SubmitAnswers,
  ): Promise<void> => {
    const trimmed = input.trim();
    // /save runs immediately even while a turn is in flight (#226): the point of saving mid-run is
    // to snapshot the conversation the moment something looks off and hand it to another agent,
    // without aborting the turn to get there. It only reads the scrollback and the counts, nothing
    // the loop is writing to. Every other command still waits: the rest either change what the
    // running turn is doing (mode, model, cwd) or reset it. Before boot there is nothing to save.
    if (session && snapshot.status !== 'idle' && isSaveCommand(input)) {
      front.onTaken(trimmed);
      await runCommand(trimmed, front);
      return;
    }
    // Held while a turn runs or the session boots, and replayed through here once idle; the
    // receipt records what was queued.
    if (!session || snapshot.status !== 'idle') {
      const answers = await askSubmitAnswers(trimmed, front, carried);
      if (answers === 'abort') return;
      const msg = queuedMessage(trimmed, front.images, answers);
      if (!msg) return;
      front.onImagesTaken?.();
      controller.enqueue(msg);
      // The queued list is now the source of truth for it.
      front.onTaken();
      return;
    }
    // Unconditional: commands and shell lines land here too.
    front.onSending?.();
    // Before the box clears: the dialog sits over the input, and the prompt it is asking about
    // should still be visible underneath.
    const answers = await askSubmitAnswers(trimmed, front, carried);
    if (answers === 'abort') return;
    const { skill: route, fetchUrls, implementMode } = answers;
    front.onTaken(trimmed || undefined);
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      await runCommand(trimmed, { ...front, implementMode });
      return;
    }
    if (snapshot.mode === 'shell') {
      await controller.runShell(expandPastes(trimmed, front.pastes), front.shell);
      return;
    }
    await controller.submitPrompt(
      trimmed,
      {
        answers: { skill: route, fetchUrls },
        images: front.images,
        pastes: front.pastes,
        onStage: front.onStage,
        onBuilt: front.onImagesTaken,
      },
      front.turn,
    );
  };

  const controller: Controller = {
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
    setStatus,
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
    requestApproval,
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
    toggleCommand: (name, args) => {
      const cfg = config();
      return resolveToggleCommand(name, args, {
        autoApprove: autoApprove(),
        autoApproveForced: cfg ? autoApproveForced(cfg) : false,
        configAutoApprove: cfg?.autoApprove,
        unattended: unattended(),
        anon: isAnon(),
      });
    },
    setToggle: async (toggle, on, echo) => {
      let identity: { names: number; emails: number } | undefined;
      if (toggle === 'approvals') {
        if (on !== snapshot.sessionAutoApprove) set({ sessionAutoApprove: on });
      } else if (toggle === 'unattended') {
        if (on !== snapshot.sessionUnattended) set({ sessionUnattended: on });
      } else if (on) {
        // Not gated on REIKA_ANON: the env var is the starting state, and this is for the user
        // about to record who did not set it.
        const found = await enableAnon(session?.bundle.cwd ?? process.cwd());
        identity = { names: found.names.length, emails: found.emails.length };
      } else {
        clearIdentity();
      }
      append(...(echo ? [echo] : []), {
        role: 'system',
        content: toggleReceipt(toggle, on, identity),
      });
    },
    takeUnattendedDeclines: () => {
      const taken = unattendedDeclines;
      unattendedDeclines = [];
      return taken;
    },
    openQuestion,
    answerQuestion: answer => {
      const resolve = resolveQuestion;
      if (!resolve) return;
      resolveQuestion = null;
      set({ question: null });
      resolve(answer);
    },
    openConfirm,
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
    boot,
    attachSession,
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
      heldShellRuns = [];
      startedAt = Date.now();
      // A new conversation gets a new file.
      stopSaveTimer();
      sessionPath = null;
      saveHold = null;
      set({
        messages: [
          echo,
          { role: 'system', content: 'New session — conversation, tokens, and mode reset.' },
        ],
        approvals: { approved: 0, declined: 0 },
        sessionAutoApprove: null,
        ...freshMeasurements(),
        // The tok/s chip goes with the token counts it sits next to (#204).
        decodeRate: undefined,
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
      // A project session carries on in its own file. A manual save from the root is left as it
      // was, and the continuation gets a project file of its own at its next save.
      stopSaveTimer();
      sessionPath = dirname(from.path) === projectDir() ? from.path : null;
      if (sessionPath) logSessionFile(sessionPath);
      saveHold = countRealTurns(sides.agent) + countRealTurns(sides.chat);
      // Emptied first so a line the mode change prints below can be told from the old scrollback.
      // The decode rate stays: the model is the same one unless the mode change below brings another.
      set({ messages: [], ...freshMeasurements() });
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
    sides: bothSides,
    get sessionPath() {
      return sessionPath;
    },
    saveNow,
    changeDirectory: async (target, echo) => {
      const path = target.trim();
      if (!path) {
        append(echo, { role: 'system', content: 'Usage: /cd <path>' });
        return;
      }
      if (!session) return;
      const expanded = expandHome(path);
      const cwd = isAbsolute(expanded) ? expanded : resolve(session.bundle.cwd, expanded);
      set({
        status: 'busy',
        messages: [...snapshot.messages, echo, { role: 'system', content: `Re-indexing ${cwd}…` }],
      });
      try {
        const bundle = await bootstrap(cwd, session.bundle.repoMapBudget);
        session.updateBundle(() => bundle);
        append({ role: 'system', content: `cwd is now ${cwd}` });
      } catch (e) {
        append({ role: 'system', content: `cd failed: ${(e as Error).message}` });
      } finally {
        set({ status: 'idle' });
      }
    },
    saveTranscript: async (raw, echo) => {
      if (!session) return;
      // The round still streaming is not a message yet, so the receipt says where a mid-turn save
      // stops, or the transcript reads as one that ends without a reply.
      const midTurn = snapshot.status === 'busy';
      const msgs = snapshot.messages;
      if (msgs.length === 0) {
        append(echo, { role: 'system', content: 'Nothing to save yet.' });
        return;
      }
      try {
        const { jsonlPath, txtPath } = await writeTranscript(
          historyRoot,
          msgs,
          saveHeader(transcriptMeta(session, msgs, midTurn), msgs),
          { redact: !raw },
        );
        append(echo, {
          role: 'system',
          content: `saved ${msgs.length} messages${raw ? ' (raw, unredacted)' : ''}${midTurn ? ' — mid-turn, up to the last completed round; the turn continues' : ''} → ${jsonlPath}\n(+ ${txtPath})`,
        });
      } catch (e) {
        append(echo, { role: 'error', content: `save failed: ${(e as Error).message}` });
      }
    },
    resumeList: async args => {
      const dir = projectDir();
      if (!session || !dir) return { reply: 'config not loaded' };
      if (snapshot.status === 'busy') {
        return { reply: 'Cannot resume while busy. Wait or ctrl-c to abort.' };
      }
      const target = args.trim().toLowerCase();
      if (target !== '' && target !== 'all' && target !== 'root') {
        return {
          reply:
            'Usage: /resume (this project; chats only in chat mode), /resume all, or /resume root (manual /save files).',
        };
      }
      // A project file saved before the header counted chat turns is not listed as a chat;
      // /resume all still has it.
      const chatsOnly = target === '' && snapshot.mode === 'chat';
      let entries: SessionEntry[] = [];
      let heading = 'saved with /save';
      if (target !== 'root') {
        // The session in progress is not something to resume into.
        entries = (await listSessions(dir)).filter(e => e.path !== sessionPath);
        if (chatsOnly) entries = entries.filter(e => e.chat);
        heading = chatsOnly ? 'chats in this project' : 'this project';
      }
      // In chat mode the fallback is the manual saves that hold a chat (#882).
      if (entries.length === 0) {
        entries = await listSessions(historyRoot, true);
        if (chatsOnly) entries = entries.filter(e => e.chat);
        if (target === '' && entries.length > 0)
          heading = chatsOnly
            ? 'no chats for this project — saved with /save'
            : 'none for this project — saved with /save';
      }
      if (entries.length > 0) return { entries, heading };
      if (chatsOnly) {
        return { reply: 'No saved chats for this project. /resume all lists every session.' };
      }
      return {
        reply:
          target === 'root'
            ? `No saved sessions in ${historyRoot}.`
            : session.getSnapshot().config.autosave
              ? 'No saved sessions for this project yet.'
              : 'No saved sessions for this project (auto-save is off: REIKA_AUTOSAVE=0).',
      };
    },
    runTurn,
    submitPrompt: async (text, input, front) => {
      const s = session;
      const cfg = config();
      if (!s || !cfg || submitting) return;
      submitting = true;
      let modelText: string;
      let built: Awaited<ReturnType<typeof buildSubmitInput>>;
      try {
        built = await buildSubmitInput(text, {
          cwd: s.bundle.cwd,
          skills: s.bundle.skills,
          config: resolveProfile(cfg, s.profile),
          skillRoute: input.answers.skill,
          skillHints: hintedSkills,
          fetchUrls: input.answers.fetchUrls,
          images: input.images,
          pastes: input.pastes,
          onStage: input.onStage,
        });
        // Clipboard attachments are consumed by the turn that sends them: the marker stays visible
        // in the bubble, but recalling that text from history later must not silently re-attach an
        // image the user has moved on from.
        input.onBuilt?.();
        modelText = built.modelText;
        // Chat's history is its own, and its tools could not act on a run anyway: held for the
        // agent side.
        if (heldShellRuns.length > 0 && snapshot.mode !== 'chat') {
          const budget = shellRunBudget(s.config.contextWindow);
          modelText = `${buildShellRunsBlock(heldShellRuns, budget)}\n\n${modelText}`;
          heldShellRuns = [];
        }
      } finally {
        input.onStage(null);
        submitting = false;
      }
      await runTurn(
        modelText,
        {
          // Vibe runs the plan→implement chain (#45) inside the session.
          ...(snapshot.mode === 'vibe' ? { mode: 'vibe' as const } : {}),
          display: built.display !== modelText ? built.display : undefined,
          nativeImages: built.nativeImages,
          skill: built.skill,
          notices: built.notices.map(n => ({ role: 'system' as const, ...n })),
        },
        front,
      );
    },
    runShell: async (command, front) => {
      const s = session;
      if (!s) return;
      // Shell mode is "raw bash, no model": the echo and the `shell` message are UI-only. The model
      // sees the run through the held copy, attached to the next prompt.
      append({ role: 'user', content: command, meta: true });
      setStatus('busy');
      front.onStart?.();
      // Same bounds and the same ctrl-c as a model-run command: the shell is the user's, but the
      // front end is blocked on it just the same.
      const running = new AbortController();
      aborter = running;
      try {
        const result = await execStream(command, {
          cwd: s.bundle.cwd,
          bashTimeoutMs: config()?.bashTimeoutMs,
          bashIdleMs: config()?.bashIdleMs,
          signal: running.signal,
          onProgress: front.onProgress,
        });
        append({ role: 'shell', command, output: result.payload ?? '' });
        heldShellRuns = holdShellRun(
          heldShellRuns,
          await captureShellRun(command, result.exitCode ?? null, result.payload ?? ''),
        );
      } catch (e) {
        append({ role: 'error', content: (e as Error).message });
      } finally {
        front.onEnd?.();
        aborter = null;
        setStatus('idle');
      }
    },
    // `/filesystem:read_file {"path":"src/index.ts"}`. No approval prompt: the user typed it, the
    // rule shell mode runs under. The result is a command and its output, and the user reading the
    // tool, not the model calling it.
    runMcpCommand: async (raw, command, args) => {
      const s = session;
      if (!s) return;
      const parsed = parseMcpArgs(command, args);
      if ('error' in parsed) {
        append({ role: 'system', content: parsed.error, tone: 'warn' });
        return;
      }
      setStatus('busy');
      const running = new AbortController();
      aborter = running;
      try {
        const result = await invokeMcpTool(
          s.mcp.call,
          `${command.server}:${command.tool}`,
          command.server,
          command.tool,
          parsed.args,
          { signal: running.signal },
        );
        const output = [result.summary, result.payload].filter(Boolean).join('\n');
        append({ role: 'shell', command: raw, output });
      } finally {
        aborter = null;
        setStatus('idle');
      }
    },
    abort: () => {
      if (snapshot.status !== 'busy' || !aborter) return false;
      aborter.abort();
      return true;
    },
    runCommand,
    submit,
  };
  return controller;
}
