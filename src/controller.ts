import { canDrain, queueReceipt, takeNext, type QueuedMessage } from './agent/busyqueue.js';
import { modeSide } from './agent/modes.js';
import type { Message, Mode } from './types.js';

// The conversation a front end shows, held outside any UI framework (#584): the scrollback of the
// side on screen, the other side's scrollback while it is off screen, the mode, whether a turn is
// running, and the prompts waiting for it to end. A front end
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
  takeQueued(blockers: { dialogOpen: boolean; resuming: boolean }): QueuedMessage | null;
  replayDone(): void;
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
}): Controller {
  let snapshot: ControllerSnapshot = {
    messages: [],
    mode: opts.mode,
    status: 'loading',
    queue: [],
    replaying: false,
  };
  let stashed: Partial<Record<Side, Message[]>> = {};
  const listeners = new Set<() => void>();

  const set = (next: Partial<ControllerSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
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
      const drainable = canDrain({
        idle: snapshot.status === 'idle',
        replaying: snapshot.replaying,
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
