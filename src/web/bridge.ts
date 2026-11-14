import { frozenStreamMessage } from '../agent/frozenstream.js';
import type { Controller, InputFrontEnd, ShellFrontEnd, TurnFrontEnd } from '../controller.js';
import type { ImageAttachment } from '../agent/attachments.js';
import { loadSession, type SessionEntry, type SessionSides } from '../store/sessions.js';
import type { ApprovalRequest, Message, QuestionRequest } from '../types.js';
import type { ConfirmSpec } from '../ui/dialogspecs.js';
import type { ModelTarget } from '../ui/models.js';
import {
  approvalDialog,
  confirmDialog,
  dialogEvent,
  emptyLive,
  helloEvent,
  messageEvent,
  modelDialog,
  questionDialog,
  resetEvent,
  resolvedEvent,
  sameState,
  sessionDialog,
  stateEvent,
  wireState,
  type ClientMessage,
  type CommittedEvent,
  type ServerEvent,
  type WireDialog,
  type WireLive,
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
  // Never throws.
  handle(message: ClientMessage): HandleResult;
  close(): void;
};

export type HandleResult = { ok: true } | { ok: false; error: string; conflict?: true };

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
  | { kind: 'model' }
  | { kind: 'session'; entries: SessionEntry[] }
);

type ControllerOpenDialog = Extract<OpenDialog, { kind: ControllerDialogKind }>;

function startsWithByIdentity(next: Message[], prev: Message[]): boolean {
  return next.length >= prev.length && prev.every((m, i) => next[i] === m);
}

export function createWebBridge(
  controller: Controller,
  opts: { now?: () => number; onExit?: () => void; maxLogEvents?: number } = {},
): WebBridge {
  const now = opts.now ?? Date.now;
  const maxLogEvents = opts.maxLogEvents ?? MAX_LOG_EVENTS;
  const listeners = new Set<(event: ServerEvent) => void>();
  let closed = false;

  let lastSeq = 0;
  // The seq of the newest event the bounded log has let go of: an `afterSeq` below it is a gap.
  let droppedThrough = 0;
  const log: CommittedEvent[] = [];

  let messages = controller.messages;
  let state: WireState = wireState(controller);
  let dialogCounter = 0;
  const dialogs = new Map<string, OpenDialog>();
  const fromController: Record<ControllerDialogKind, ControllerOpenDialog | null> = {
    approval: null,
    question: null,
    confirm: null,
  };
  // The row `ask` was handed for the spec it is about to open.
  let askedInitial: { spec: ConfirmSpec; initial: number } | null = null;

  let live: WireLive = emptyLive();
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

  const dialogBlocksPending = (): boolean =>
    fromController.approval !== null || fromController.question !== null;
  // #509: the approval happens inside the call, after it was announced, so a pending row under an
  // unanswered prompt would name work that has not been permitted.
  const liveView = (): WireLive => ({
    ...live,
    pending: dialogBlocksPending() ? null : live.pending,
  });
  const emitLive = (): void => emit({ type: 'live', live: liveView() });
  const setLive = (next: Partial<WireLive>): void => {
    live = { ...live, ...next };
    emitLive();
  };

  const openDialog = (entry: OpenDialog): void => {
    dialogs.set(entry.id, entry);
    commit(seq => dialogEvent(seq, entry.id, entry.dialog));
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
    const initial = askedInitial?.spec === spec ? askedInitial.initial : 0;
    askedInitial = null;
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
    const blockedBefore = dialogBlocksPending();
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
    if (live.pending && blockedBefore !== dialogBlocksPending()) emitLive();
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
        const nextState = wireState(controller);
        if (!sameState(state, nextState)) {
          state = nextState;
          commit(seq => stateEvent(seq, nextState));
        }
      } while (dirty);
    } finally {
      syncing = false;
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

  const toolProgress = (chunk: string, name: string): void => {
    if (live.tool && live.tool.name === name) {
      live = { ...live, tool: { name, output: live.tool.output + chunk } };
      emit({ type: 'delta', channel: 'tool', text: chunk });
      return;
    }
    setLive({ tool: { name, output: chunk } });
  };

  const turnFrontEnd: TurnFrontEnd = {
    onTurnStart: () => {
      // The plan checklist is cleared too; the turn's seed restores it when a plan is in history.
      setLive({ ...emptyLive(), phase: 'thinking' });
    },
    onTurnEnd: () => {
      // The checklist outlives its turn, so the user sees what is left before continuing.
      setLive({ ...emptyLive(), plan: live.plan });
    },
    onMessage: msg => {
      if (msg.role === 'assistant') setLive({ content: '', reasoning: '' });
      // The result the pending row stood in for has landed.
      else if (msg.role === 'tool') setLive({ tool: null, pending: null });
    },
    events: {
      onContentDelta: delta => {
        live = { ...live, content: live.content + delta };
        emit({ type: 'delta', channel: 'content', text: delta });
      },
      onReasoningDelta: delta => {
        live = { ...live, reasoning: live.reasoning + delta };
        emit({ type: 'delta', channel: 'reasoning', text: delta });
      },
      onToolProgress: toolProgress,
      onToolStart: name => setLive({ pending: { name, since: now() } }),
      onPhase: phase => setLive({ phase }),
      onSubagent: subagent => setLive({ subagent }),
      onCompactionNote: note => setLive({ note }),
      onTypecheck: typechecking => setLive({ typechecking }),
      onRecovering: recovering => setLive({ recovering }),
      // Copied: the loop mutates its tracker array in place.
      onPlanProgress: steps => setLive({ plan: steps.map(step => ({ ...step })) }),
      onPromptProgress: progress => setLive({ promptProgress: progress ?? null }),
      onLiveUsage: usage => setLive({ usage: usage ?? null }),
      // The controller has the real count; the estimate it replaces is shown no more.
      onUsage: () => {
        if (live.usage !== null) setLive({ usage: null });
      },
      onReasoningReset: () => {
        const frozen = frozenStreamMessage({
          content: live.content,
          reasoning: live.reasoning,
          note: live.note,
          nested: live.subagent,
        });
        // The compaction note round streams as content and commits as a notice, which clears no
        // content preview, so the next reply would stream onto the note's tail.
        live = { ...live, content: '', reasoning: '' };
        if (frozen) controller.append(frozen);
        emitLive();
      },
    },
  };

  // Shell output streams through the tool block under an empty tool name, as in the TUI.
  const shellFrontEnd: ShellFrontEnd = {
    onStart: () => setLive({ tool: null }),
    onProgress: chunk => toolProgress(chunk, ''),
    onEnd: () => setLive({ tool: null }),
  };

  const supersedePicker = (kind: 'model' | 'session'): void => {
    for (const entry of [...dialogs.values()]) if (entry.kind === kind) closeDialog(entry);
  };

  const ask = (spec: ConfirmSpec, initial = 0): Promise<number | 'abort'> => {
    askedInitial = { spec, initial: Math.max(0, Math.min(initial, spec.options.length - 1)) };
    return controller.openConfirm(spec);
  };

  const inputFrontEnd = (images: ImageAttachment[] = []): InputFrontEnd => ({
    turn: turnFrontEnd,
    pastes: [],
    images,
    ask,
    exit: () => opts.onExit?.(),
    pickModel: (targets: ModelTarget[]) => {
      supersedePicker('model');
      openDialog({ id: nextId(), kind: 'model', dialog: modelDialog(targets), answered: false });
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
    onNewConversation: () => setLive(emptyLive()),
    shell: shellFrontEnd,
    onStage: () => {},
    onTaken: () => {},
  });

  const resume = async (entry: SessionEntry): Promise<void> => {
    let sides: SessionSides;
    try {
      sides = await loadSession(entry.path);
    } catch (e) {
      controller.append({ role: 'error', content: `resume failed: ${(e as Error).message}` });
      return;
    }
    // Save whatever this session had before it is replaced.
    await controller.saveNow();
    setLive(emptyLive());
    controller.replace(controller.loadConversation(sides, entry));
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
      case 'model':
        entry.answered = true;
        closeDialog(entry);
        if (message.name !== null) controller.pickModel(message.name);
        return { ok: true };
      case 'session': {
        if (message.path === null) {
          entry.answered = true;
          closeDialog(entry);
          return { ok: true };
        }
        const offered = entry.kind === 'session' ? entry.entries : [];
        const picked = offered.find(e => e.path === message.path);
        // Only a file this dialog listed: a tab's path is never read as given.
        if (!picked) return { ok: false, error: 'path is not one this dialog offered' };
        if (resuming || controller.status !== 'idle') {
          return { ok: false, error: 'cannot resume while busy' };
        }
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
    ...[...dialogs.values()].map(d => dialogEvent(lastSeq, d.id, d.dialog)),
    { type: 'live', live: liveView() },
  ];

  return {
    connect: afterSeq => {
      const covered =
        afterSeq !== undefined &&
        Number.isInteger(afterSeq) &&
        afterSeq >= droppedThrough &&
        afterSeq <= lastSeq;
      if (!covered) return snapshotEvents();
      return [...log.filter(e => e.seq > afterSeq), { type: 'live', live: liveView() }];
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handle: message => {
      if (closed) return { ok: false, error: 'closed' };
      try {
        switch (message.type) {
          case 'submit':
            // Left with the tab, as the TUI leaves it in the box: the resume replaces the
            // conversation it was typed against.
            if (resuming) return { ok: false, error: 'a session is still loading' };
            void submitSafely(message.text, inputFrontEnd());
            return { ok: true };
          case 'abort':
            controller.abort();
            return { ok: true };
          case 'answer':
            return answer(message);
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    close: () => {
      if (closed) return;
      supersedePicker('model');
      supersedePicker('session');
      closed = true;
      unsubscribeController();
      unsubscribeSession?.();
      unsubscribeSession = null;
      listeners.clear();
    },
  };
}
