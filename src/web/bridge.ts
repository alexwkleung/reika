import type { Controller, InputFrontEnd } from '../controller.js';
import type { ImageAttachment } from '../agent/attachments.js';
import { loadSession, type SessionEntry, type SessionSides } from '../store/sessions.js';
import type { ApprovalRequest, Message, QuestionRequest } from '../types.js';
import type { ConfirmSpec } from '../ui/dialogspecs.js';
import type { ModelTarget } from '../ui/models.js';
import { adoptPastes, type PastedText } from '../ui/pastes.js';
import { submitStageLabel } from '../agent/submitinput.js';
import { compactThreshold } from '../agent/compaction.js';
import { scrubGeneration } from '../ui/identity.js';
import { scrubDisplay, scrubOutput } from '../ui/scrub.js';
import {
  createStreamScrubber,
  liveChannelText,
  scrubCompletion,
  scrubDialog,
  scrubError,
  scrubLive,
  scrubMessage,
  scrubSessionList,
  scrubState,
  type LiveChannel,
  type StreamScrubber,
} from './scrubwire.js';
import {
  approvalDialog,
  catalogEvent,
  historyAddEvent,
  historyEvent,
  sameCatalog,
  wireCatalog,
  type WireCatalog,
  type WireCompletion,
  confirmDialog,
  dialogEvent,
  helloEvent,
  liveEvent,
  modelDialog,
  questionDialog,
  resolvedEvent,
  sameState,
  sessionId,
  wireSessionEntry,
  MAX_LISTED_SESSIONS,
  type SessionScope,
  type WireSessionList,
  sessionDialog,
  stateEvent,
  wireState,
  type ClientMessage,
  type CommittedEvent,
  type ServerEvent,
  type WireDialog,
  type WireMessage,
  type WireState,
} from './protocol.js';

// The session side of the web front end (#584/#595): drives a controller as one more front end,
// turns what changes into the protocol's events, and turns a tab's messages into controller calls.
// No HTTP here; the server in front of it only moves these events and messages.

// Enough for a tab that dropped for a minute mid-turn to catch up on rows; one gone longer gets a
// snapshot, which costs a reset rather than a replay.
export const MAX_LOG_EVENTS = 2000;

export type WebBridge = {
  // A snapshot (hello, reset, state, every open dialog, live) for a fresh tab or one whose
  // `afterSeq` the log no longer covers; otherwise the committed events after it, then live.
  connect(afterSeq?: number): ServerEvent[];
  subscribe(listener: (event: ServerEvent) => void): () => void;
  // Never throws or rejects. A message that reads the history directory answers in a promise.
  handle(message: ClientMessage): HandleResult | Promise<HandleResult>;
  close(): void;
};

// `reply` is what a `complete` or a `sessions` asks for, sent back as the POST's body.
export type HandleResult =
  | { ok: true; reply?: WireCompletion | WireSessionList }
  | { ok: false; error: string; conflict?: true };

type ControllerDialogKind = 'approval' | 'question' | 'confirm';

type OpenDialog = {
  id: string;
  dialog: WireDialog;
  // Set just before this bridge answers it, so the close reads as answered rather than cancelled.
  answered: boolean;
} & (
  | { kind: 'approval'; source: ApprovalRequest }
  | { kind: 'question'; source: QuestionRequest }
  | { kind: 'confirm'; source: ConfirmSpec; rows: number }
  | { kind: 'model'; targets: ModelTarget[] }
  | { kind: 'session'; entries: SessionEntry[] }
);

type ControllerOpenDialog = Extract<OpenDialog, { kind: ControllerDialogKind }>;

// The TUI status line's ceiling (ui/App.tsx): the session's config carries the reserve it resolved,
// learned or pinned, which is what the next request will be held under.
export function contextUsable(controller: Controller): number | null {
  const session = controller.session;
  if (!session) return null;
  const cfg = session.getSnapshot().config;
  const profile = cfg.profiles[session.profile] ?? cfg.profiles.default;
  // The window as wireState names it, so the meter's two numbers come from one profile.
  const window = profile?.contextWindow ?? cfg.contextWindow;
  if (!window) return null;
  return Math.round(compactThreshold(window, session.config?.minGenTokens ?? cfg.minGenTokens));
}

function startsWithByIdentity(next: Message[], prev: Message[]): boolean {
  return next.length >= prev.length && prev.every((m, i) => next[i] === m);
}

export function createWebBridge(
  controller: Controller,
  // `now` must be the controller's clock: a live event pairs it with `pending.since`.
  opts: { onExit?: () => void; maxLogEvents?: number; now?: () => number } = {},
): WebBridge {
  const now = opts.now ?? Date.now;
  const maxLogEvents = opts.maxLogEvents ?? MAX_LOG_EVENTS;
  const listeners = new Set<(event: ServerEvent) => void>();
  let closed = false;

  let lastSeq = 0;
  // The seq of the newest event the bounded log has let go of: an `afterSeq` below it is a gap.
  let droppedThrough = 0;
  const log: CommittedEvent[] = [];

  // What a submit is waiting on, from the controller's onStage hook; the controller keeps none.
  let stage: string | null = null;
  // The scrub rules in force (#990): `/anon` swaps them, and everything a tab holds is re-sent.
  let generation = scrubGeneration();
  // Read at each scrub: `/cd` moves it, and the process's own cwd never follows.
  const cwd = (): string => controller.session?.bundle.cwd ?? process.cwd();
  // A message is scrubbed once per rule set, against the cwd it was first sent under, so its rows
  // do not change on a reload after a `/cd`.
  const wired = new WeakMap<Message, { generation: number; cwd: string; wire: WireMessage }>();
  const wire = (m: Message): WireMessage => {
    const hit = wired.get(m);
    if (hit && hit.generation === generation) return hit.wire;
    const at = hit?.cwd ?? cwd();
    const out = scrubMessage(m, at);
    wired.set(m, { generation, cwd: at, wire: out });
    return out;
  };
  const scrubbedState = (): WireState =>
    scrubState(wireState(controller, stage, contextUsable(controller)));
  const scrubbedDialog = (d: WireDialog): WireDialog => scrubDialog(d, cwd());
  const streamed: Record<LiveChannel, StreamScrubber> = {
    content: createStreamScrubber(s => scrubDisplay(s, cwd())),
    reasoning: createStreamScrubber(s => scrubDisplay(s, cwd())),
    tool: createStreamScrubber(s => scrubOutput(s, cwd())),
  };
  let streamedTool: string | null = null;
  // Brought up to the controller's live text: a delta missed, a new round, a new tool block.
  const catchUpStreams = (force = false): void => {
    const toolName = controller.live.tool?.name ?? null;
    for (const channel of ['content', 'reasoning', 'tool'] as const) {
      const scrubber = streamed[channel];
      const raw = liveChannelText(controller.live, channel);
      const sameBlock = channel !== 'tool' || toolName === streamedTool;
      if (!force && sameBlock && raw === scrubber.raw) continue;
      if (!force && sameBlock && raw.startsWith(scrubber.raw)) {
        scrubber.push(raw.slice(scrubber.raw.length));
      } else scrubber.reset(raw);
    }
    streamedTool = toolName;
  };
  const messageEvent = (seq: number, m: Message): CommittedEvent => ({
    type: 'message',
    seq,
    message: wire(m),
  });
  const resetEvent = (seq: number, all: Message[]): CommittedEvent => ({
    type: 'reset',
    seq,
    messages: all.map(wire),
  });
  let messages = controller.messages;
  let state: WireState = scrubbedState();
  let catalog: WireCatalog = wireCatalog(controller);
  let history = controller.getSnapshot().history;
  // Pastes from every tab, session-long as the TUI keeps its own: a recalled line's markers must
  // still expand, and a queued line's at replay.
  let pastes: PastedText[] = [];
  let dialogCounter = 0;
  const dialogs = new Map<string, OpenDialog>();
  const fromController: Record<ControllerDialogKind, ControllerOpenDialog | null> = {
    approval: null,
    question: null,
    confirm: null,
  };
  // The row `ask` was handed for the spec it is about to open. Per spec: a confirm asked while another is open waits its turn (#993), so two can be asked
  // before either is shown.
  const askedInitial = new Map<ConfirmSpec, number>();

  // A resume is reading its file: a submit now would land in the conversation it is replacing.
  let resuming = false;

  const emit = (event: ServerEvent): void => {
    if (closed) return;
    for (const listener of [...listeners]) {
      // A listener is a tab's connection, and this runs inside the controller's own update: a
      // write that throws must cost that tab its stream, not the turn.
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
  };
  const commit = (make: (seq: number) => CommittedEvent): void => {
    const event = make(++lastSeq);
    log.push(event);
    while (log.length > maxLogEvents) droppedThrough = log.shift()!.seq;
    emit(event);
  };

  const scrubbedLive = (): ServerEvent => {
    catchUpStreams();
    const text = {
      content: streamed.content.text(),
      reasoning: streamed.reasoning.text(),
      tool: streamed.tool.text(),
    };
    return liveEvent(scrubLive(controller.live, text, cwd()), now());
  };
  const emitLive = (): void => emit(scrubbedLive());

  const openDialog = (entry: OpenDialog): void => {
    dialogs.set(entry.id, entry);
    commit(seq => dialogEvent(seq, entry.id, scrubbedDialog(entry.dialog)));
  };
  const closeDialog = (entry: OpenDialog): void => {
    if (!dialogs.delete(entry.id)) return;
    commit(seq => resolvedEvent(seq, entry.id, entry.answered ? 'answered' : 'cancelled'));
  };
  const nextId = (): string => `d${++dialogCounter}`;

  const controllerDialog = (
    kind: ControllerDialogKind,
    source: ApprovalRequest | QuestionRequest | ConfirmSpec,
  ): ControllerOpenDialog => {
    const id = nextId();
    if (kind === 'approval') {
      const request = source as ApprovalRequest;
      return { id, kind, source: request, dialog: approvalDialog(request), answered: false };
    }
    if (kind === 'question') {
      const request = source as QuestionRequest;
      return { id, kind, source: request, dialog: questionDialog(request), answered: false };
    }
    const spec = source as ConfirmSpec;
    const initial = askedInitial.get(spec) ?? 0;
    askedInitial.delete(spec);
    return {
      id,
      kind,
      source: spec,
      rows: spec.options.length,
      dialog: confirmDialog(spec, initial),
      answered: false,
    };
  };

  const syncDialogs = (): void => {
    const snap = controller.getSnapshot();
    for (const kind of ['approval', 'question', 'confirm'] as const) {
      const current = snap[kind];
      const tracked = fromController[kind];
      if (tracked && tracked.source === current) continue;
      if (tracked) {
        fromController[kind] = null;
        closeDialog(tracked);
      }
      if (current) {
        const entry = controllerDialog(kind, current);
        fromController[kind] = entry;
        openDialog(entry);
      }
    }
  };

  let session = controller.session;
  let unsubscribeSession = session?.subscribe(() => sync()) ?? null;
  const followSession = (): void => {
    if (controller.session === session) return;
    unsubscribeSession?.();
    session = controller.session;
    unsubscribeSession = session?.subscribe(() => sync()) ?? null;
  };

  // A listener of ours may call `handle`, which changes the controller inside this pass; that
  // change is taken by one more pass after this one, so events never interleave.
  let syncing = false;
  let dirty = false;
  // A live change made inside a pass is sent after it, behind the dialog events it follows.
  let liveHeld = false;
  const sync = (): void => {
    if (closed) return;
    if (syncing) {
      dirty = true;
      return;
    }
    syncing = true;
    try {
      do {
        dirty = false;
        followSession();
        const nextGeneration = scrubGeneration();
        if (nextGeneration !== generation) {
          // A tab reconnecting must not be replayed what was sent under the old rules: the log
          // empties, so anything older than now gets a snapshot.
          generation = nextGeneration;
          log.length = 0;
          droppedThrough = lastSeq;
          catchUpStreams(true);
          commit(seq => resetEvent(seq, messages));
          state = scrubbedState();
          commit(seq => stateEvent(seq, state));
          for (const entry of dialogs.values()) {
            commit(seq => dialogEvent(seq, entry.id, scrubbedDialog(entry.dialog)));
          }
          liveHeld = true;
        }
        const next = controller.messages;
        if (next !== messages) {
          const prev = messages;
          messages = next;
          if (startsWithByIdentity(next, prev)) {
            for (const m of next.slice(prev.length)) commit(seq => messageEvent(seq, m));
          } else {
            commit(seq => resetEvent(seq, next));
          }
        }
        syncDialogs();
        const nextState = scrubbedState();
        if (!sameState(state, nextState)) {
          state = nextState;
          commit(seq => stateEvent(seq, nextState));
        }
        const nextCatalog = wireCatalog(controller);
        if (!sameCatalog(catalog, nextCatalog)) {
          catalog = nextCatalog;
          commit(seq => catalogEvent(seq, nextCatalog));
        }
        const nextHistory = controller.getSnapshot().history;
        if (nextHistory !== history) {
          const prev = history;
          history = nextHistory;
          const appended =
            nextHistory.length === prev.length + 1 && prev.every((l, i) => nextHistory[i] === l);
          if (appended) commit(seq => historyAddEvent(seq, nextHistory[prev.length]));
          else commit(seq => historyEvent(seq, nextHistory));
        }
      } while (dirty);
    } finally {
      syncing = false;
    }
    if (liveHeld) {
      liveHeld = false;
      emitLive();
    }
    scheduleDrain();
  };

  // Queued prompts are replayed once the controller is idle, as the TUI does; a microtask, so the
  // replay never runs inside the change that freed the queue.
  let drainQueued = false;
  const scheduleDrain = (): void => {
    if (drainQueued) return;
    drainQueued = true;
    queueMicrotask(() => {
      drainQueued = false;
      if (closed) return;
      const next = controller.takeQueued({ resuming });
      if (!next) return;
      void submitSafely(next.content, inputFrontEnd(next.images ?? []), next.answers).finally(() =>
        controller.replayDone(),
      );
    });
  };

  const submitSafely = (
    text: string,
    front: InputFrontEnd,
    carried?: Parameters<Controller['submit']>[2],
  ): Promise<void> =>
    controller.submit(text, front, carried).catch((e: unknown) => {
      controller.append({ role: 'error', content: (e as Error).message });
    });

  // A switch only between lines. The status stays idle while a line asks its questions and fetches
  // its links, and the line reads the mode after those waits; a switch then would run it in a mode
  // it was not typed for. A queued line is about to replay, so it holds a switch too.
  // The same rule holds a resume (#1004): it replaces the conversation a waiting line was typed for.
  const switchRefusal = (
    what: 'modes' | 'models' | 'sessions' | 'conversations',
  ): HandleResult | null => {
    const snap = controller.getSnapshot();
    const between =
      controller.session !== null &&
      snap.status === 'idle' &&
      !snap.preparing &&
      !snap.replaying &&
      !resuming &&
      snap.queue.length === 0 &&
      snap.approval === null &&
      snap.confirm === null;
    if (between) return null;
    return {
      ok: false,
      error: `Cannot switch ${what} while a prompt is running or waiting.`,
      conflict: true,
    };
  };

  // Everything a tab is sent goes out through the bridge, replies included, so a later scrub of
  // what reaches a browser (#990) has one place to stand.
  const completionReply = (text: string): WireCompletion =>
    scrubCompletion(controller.completions(text), cwd());

  // Answered while busy, unlike `/resume`: the drawer is only looking. Filtered here rather than in
  // the tab, so a session past the cap can still be found.
  // The filter reads the titles as the tab draws them: matched raw, it would say what `/anon` hid.
  const sessionsReply = async (scope: SessionScope, filter = ''): Promise<WireSessionList> => {
    const all = await controller.sessionList(scope);
    const current = controller.sessionPath;
    const listed = scrubSessionList(
      {
        scope,
        entries: all.map(e => wireSessionEntry(e, e.path === current)),
        total: all.length,
        autosave: Boolean(controller.session?.getSnapshot().config.autosave),
      },
      cwd(),
    );
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? listed.entries.filter(e => (e.title ?? 'untitled').toLowerCase().includes(needle))
      : listed.entries;
    return { ...listed, entries: matched.slice(0, MAX_LISTED_SESSIONS), total: matched.length };
  };

  // The drawer names a session by its file name; the file opened is one this list has just found,
  // so a tab's id is never read as a path. `resuming` is set before the first await: a second
  // resume, from this tab or another, is refused rather than interleaved with this one.
  const resumeById = async (scope: SessionScope, id: string): Promise<HandleResult> => {
    resuming = true;
    try {
      const entries = await controller.sessionList(scope);
      const picked = entries.find(e => sessionId(e.path) === id);
      if (!picked) {
        return { ok: false, error: 'that session is no longer listed', conflict: true };
      }
      if (picked.path === controller.sessionPath) {
        return { ok: false, error: 'that session is the one open', conflict: true };
      }
      // A `/resume` picker's list no longer says what is open.
      supersedePicker('session');
      const loaded = await resume(picked);
      return loaded ? { ok: true } : { ok: false, error: 'the session could not be read' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      resuming = false;
      scheduleDrain();
    }
  };

  const supersedePicker = (kind: 'model' | 'session'): void => {
    for (const entry of [...dialogs.values()]) if (entry.kind === kind) closeDialog(entry);
  };

  const ask = (spec: ConfirmSpec, initial = 0): Promise<number | 'abort'> => {
    askedInitial.set(spec, Math.max(0, Math.min(initial, spec.options.length - 1)));
    return controller.openConfirm(spec);
  };

  const inputFrontEnd = (images: ImageAttachment[] = []): InputFrontEnd => ({
    turn: {},
    get pastes() {
      return pastes;
    },
    images,
    ask,
    exit: () => opts.onExit?.(),
    pickModel: (targets: ModelTarget[]) => {
      supersedePicker('model');
      openDialog({
        id: nextId(),
        kind: 'model',
        targets,
        dialog: modelDialog(targets),
        answered: false,
      });
    },
    pickSession: list => {
      supersedePicker('session');
      openDialog({
        id: nextId(),
        kind: 'session',
        entries: list.entries,
        dialog: sessionDialog(list),
        answered: false,
      });
    },
    shell: {},
    onStage: next => {
      stage = next ? submitStageLabel(next) : null;
      sync();
    },
    onTaken: () => {},
  });

  const resume = async (entry: SessionEntry): Promise<boolean> => {
    let sides: SessionSides;
    try {
      sides = await loadSession(entry.path);
    } catch (e) {
      controller.append({ role: 'error', content: `resume failed: ${(e as Error).message}` });
      return false;
    }
    // Save whatever this session had before it is replaced.
    await controller.saveNow();
    controller.replace(controller.loadConversation(sides, entry));
    return true;
  };

  const answer = (message: Extract<ClientMessage, { type: 'answer' }>): HandleResult => {
    const entry = dialogs.get(message.id);
    if (!entry || entry.kind !== message.kind) {
      return { ok: false, error: `no open ${message.kind} dialog ${message.id}`, conflict: true };
    }
    switch (message.kind) {
      case 'approval':
        entry.answered = true;
        controller.answerApproval(message.answer, { always: message.always === true });
        return { ok: true };
      case 'question':
        entry.answered = true;
        controller.answerQuestion(message.answer);
        return { ok: true };
      case 'confirm': {
        const rows = entry.kind === 'confirm' ? entry.rows : 0;
        if (message.choice !== 'abort' && message.choice >= rows) {
          return { ok: false, error: `choice must be below ${rows}` };
        }
        entry.answered = true;
        controller.answerConfirm(message.choice);
        return { ok: true };
      }
      case 'model': {
        if (message.name === null) {
          entry.answered = true;
          closeDialog(entry);
          return { ok: true };
        }
        const offered = entry.kind === 'model' ? entry.targets : [];
        // Only a target this dialog listed: an unknown name would become an ad-hoc profile, which
        // is for a typed `/model x` (#995).
        if (!offered.some(t => t.name === message.name)) {
          return { ok: false, error: 'name is not one this dialog offered' };
        }
        if (controller.status !== 'idle') return { ok: false, error: 'cannot switch while busy' };
        entry.answered = true;
        closeDialog(entry);
        controller.pickModel(message.name);
        return { ok: true };
      }
      case 'session': {
        if (message.session === null) {
          entry.answered = true;
          closeDialog(entry);
          return { ok: true };
        }
        const offered = entry.kind === 'session' ? entry.entries : [];
        const picked = offered.find(e => sessionId(e.path) === message.session);
        // Only a file this dialog listed: a tab's id is never read as a path.
        if (!picked) return { ok: false, error: 'session is not one this dialog offered' };
        // The drawer may have opened it since this picker listed it.
        if (picked.path === controller.sessionPath) {
          return { ok: false, error: 'that session is the one open', conflict: true };
        }
        const busy = switchRefusal('sessions');
        if (busy) return busy;
        entry.answered = true;
        closeDialog(entry);
        resuming = true;
        void resume(picked)
          .catch((e: unknown) => {
            controller.append({ role: 'error', content: `resume failed: ${(e as Error).message}` });
          })
          .finally(() => {
            resuming = false;
            scheduleDrain();
          });
        return { ok: true };
      }
    }
  };

  const unsubscribeController = controller.subscribe(sync);
  const unsubscribeLive = controller.subscribeLive(change => {
    if (change.type === 'delta') {
      const scrubber = streamed[change.channel];
      const raw = liveChannelText(controller.live, change.channel);
      const sameBlock = change.channel !== 'tool' || controller.live.tool?.name === streamedTool;
      if (sameBlock && raw === scrubber.raw + change.text) {
        const out = scrubber.push(change.text);
        if (out) {
          emit({
            type: 'delta',
            channel: change.channel,
            text: out.text,
            ...(out.drop > 0 ? { drop: out.drop } : {}),
          });
        }
        return;
      }
    }
    if (syncing) liveHeld = true;
    else emitLive();
  });
  // Dialogs already open when the bridge is made are listed by the next snapshot, not replayed.
  for (const kind of ['approval', 'question', 'confirm'] as const) {
    const current = controller.getSnapshot()[kind];
    if (!current) continue;
    const entry = controllerDialog(kind, current);
    fromController[kind] = entry;
    dialogs.set(entry.id, entry);
  }

  const snapshotEvents = (): ServerEvent[] => [
    // Every snapshot event carries the newest seq, so a tab that reconnects with any seq it was
    // sent here is replayed exactly what came after the snapshot.
    helloEvent(lastSeq),
    resetEvent(lastSeq, messages),
    stateEvent(lastSeq, state),
    catalogEvent(lastSeq, catalog),
    // The user's own lines, raw as the TUI's box holds them: a recalled one is sent again.
    historyEvent(lastSeq, history),
    ...[...dialogs.values()].map(d => dialogEvent(lastSeq, d.id, scrubbedDialog(d.dialog))),
    scrubbedLive(),
  ];

  const handleRaw = (message: ClientMessage): HandleResult | Promise<HandleResult> => {
    if (closed) return { ok: false, error: 'closed' };
    try {
      switch (message.type) {
        case 'submit': {
          // Left with the tab, as the TUI leaves it in the box: the resume replaces the
          // conversation it was typed against.
          if (resuming) return { ok: false, error: 'a session is still loading' };
          // Another tab switched the mode before this tab saw it: a prompt typed for agent must
          // not run as a shell command.
          if (message.mode !== undefined && message.mode !== controller.mode) {
            return {
              ok: false,
              error: `the mode is now ${controller.mode}, not ${message.mode}`,
              conflict: true,
            };
          }
          // Before anything awaits, so two tabs' pastes can never be given the same number.
          const adopted = adoptPastes(pastes, message.text, message.pastes ?? []);
          pastes = adopted.pastes;
          void submitSafely(adopted.text, inputFrontEnd());
          return { ok: true };
        }
        case 'abort':
          controller.abort();
          return { ok: true };
        case 'mode': {
          if (message.mode === controller.mode) return { ok: true };
          const busy = switchRefusal('modes');
          if (busy) return busy;
          controller.transition(message.mode);
          return { ok: true };
        }
        case 'model': {
          // A typed `/model x` reaches an ad-hoc model; a pill offers only the listed ones.
          if (!controller.modelTargets().some(t => t.name === message.name)) {
            return { ok: false, error: 'name is not one of the listed models' };
          }
          const busy = switchRefusal('models');
          if (busy) return busy;
          supersedePicker('model');
          controller.pickModel(message.name);
          return { ok: true };
        }
        case 'complete':
          return { ok: true, reply: completionReply(message.text) };
        case 'typing':
          // Sent once, on the edge into a prompt (`isWarmEdge`); the controller decides the rest.
          if (!resuming) controller.warm(message.text);
          return { ok: true };
        case 'sessions':
          return sessionsReply(message.scope, message.filter).then(
            (reply): HandleResult => ({ ok: true, reply }),
            (e: unknown): HandleResult => ({ ok: false, error: (e as Error).message }),
          );
        case 'resume': {
          const busy = switchRefusal('sessions');
          if (busy) return busy;
          return resumeById(message.scope, message.id);
        }
        case 'new': {
          // Its own message rather than a submitted `/new`, which mid-turn would be queued and
          // wipe the conversation whenever the turn ended.
          const busy = switchRefusal('conversations');
          if (busy) return busy;
          supersedePicker('session');
          controller.newConversation({ role: 'user', content: '/new', meta: true });
          return { ok: true };
        }
        case 'answer':
          return answer(message);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  // An error can quote a path, as a resume's ENOENT does.
  const scrubResult = (result: HandleResult): HandleResult =>
    result.ok ? result : { ...result, error: scrubError(result.error, cwd()) };

  return {
    connect: afterSeq => {
      const covered =
        afterSeq !== undefined &&
        Number.isInteger(afterSeq) &&
        afterSeq >= droppedThrough &&
        afterSeq <= lastSeq;
      if (!covered) return snapshotEvents();
      return [...log.filter(e => e.seq > afterSeq), scrubbedLive()];
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handle: message => {
      const result = handleRaw(message);
      return result instanceof Promise ? result.then(scrubResult) : scrubResult(result);
    },
    close: () => {
      if (closed) return;
      supersedePicker('model');
      supersedePicker('session');
      closed = true;
      unsubscribeController();
      unsubscribeLive();
      unsubscribeSession?.();
      unsubscribeSession = null;
      listeners.clear();
    },
  };
}
