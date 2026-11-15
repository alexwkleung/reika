import {
  PROTOCOL_VERSION,
  type CommittedEvent,
  type ServerEvent,
  type WireCatalog,
  type WireDialog,
  type WireLive,
  type WireMessage,
  type WireState,
} from '../protocol.js';

// Everything the tab knows about the session, folded from the event stream. One pure function, so
// the same events always give the same screen, and a reconnect is just more events.

export type OpenDialog = { id: string; dialog: WireDialog };

export type ClientState = {
  messages: WireMessage[];
  session: WireState | null;
  // The model list the pills offer, and input history for ↑/↓, shared by every tab.
  catalog: WireCatalog | null;
  history: string[];
  live: WireLive | null;
  // Arrival order, so a second dialog stacks under the first.
  dialogs: OpenDialog[];
  // The newest committed seq taken: what a reconnect asks the server to resume after.
  lastSeq: number | null;
  // Every event of a snapshot carries the same seq (bridge.ts), so while one is arriving that seq
  // is taken again; the `live` that closes every snapshot ends it.
  snapshotSeq: number | null;
  // The server's version when it differs from this page's.
  versionMismatch: number | null;
  // The server's clock minus this tab's, measured at each live event's arrival (pendingdelay.ts).
  clockOffset: number | null;
};

export const initialClientState: ClientState = {
  messages: [],
  session: null,
  catalog: null,
  history: [],
  live: null,
  dialogs: [],
  lastSeq: null,
  snapshotSeq: null,
  versionMismatch: null,
  clockOffset: null,
};

function isSnapshotEvent(state: ClientState, seq: number): boolean {
  return state.snapshotSeq !== null && seq === state.snapshotSeq;
}

// A replay can overlap what the tab already took; anything not newer is a duplicate.
function isStale(state: ClientState, seq: number): boolean {
  return state.lastSeq !== null && seq <= state.lastSeq && !isSnapshotEvent(state, seq);
}

function foldCommitted(state: ClientState, event: CommittedEvent): ClientState {
  if (event.type === 'hello') {
    // A snapshot replaces everything, whatever seq the tab held: the dialogs it lists are the open
    // ones, and the live it ends with is the turn's.
    return {
      ...state,
      dialogs: [],
      live: null,
      lastSeq: event.seq,
      snapshotSeq: event.seq,
      versionMismatch: event.version === PROTOCOL_VERSION ? null : event.version,
    };
  }
  if (isStale(state, event.seq)) return state;
  const next: ClientState = {
    ...state,
    lastSeq: event.seq,
    snapshotSeq: isSnapshotEvent(state, event.seq) ? state.snapshotSeq : null,
  };
  switch (event.type) {
    case 'message':
      return { ...next, messages: [...state.messages, event.message] };
    case 'reset':
      // Messages only: dialogs close by their own `resolved`, and live is sent on its own.
      return { ...next, messages: event.messages };
    case 'state':
      return { ...next, session: event.state };
    case 'dialog': {
      const entry = { id: event.id, dialog: event.dialog };
      const at = state.dialogs.findIndex(d => d.id === event.id);
      const dialogs =
        at === -1 ? [...state.dialogs, entry] : state.dialogs.map((d, i) => (i === at ? entry : d));
      return { ...next, dialogs };
    }
    case 'resolved': {
      const dialogs = state.dialogs.some(d => d.id === event.id)
        ? state.dialogs.filter(d => d.id !== event.id)
        : state.dialogs;
      return { ...next, dialogs };
    }
    case 'catalog':
      return { ...next, catalog: event.catalog };
    case 'history':
      return { ...next, history: event.entries };
    case 'historyAdd':
      return { ...next, history: [...state.history, event.entry] };
    default:
      // An event this page does not know: a newer server, which `hello` has already flagged.
      // Taken for its seq so a reconnect does not ask for it again.
      return next;
  }
}

function foldDelta(
  state: ClientState,
  event: Extract<ServerEvent, { type: 'delta' }>,
): ClientState {
  const live = state.live;
  // A delta extends a snapshot; with none taken yet there is nothing to extend, and the next
  // `live` carries the text whole.
  if (!live) return state;
  if (event.channel === 'tool') {
    // The controller sends a chunk for another tool as `live`, never as a delta, so a tool delta
    // always belongs to the block on screen.
    if (!live.tool) return state;
    return {
      ...state,
      live: { ...live, tool: { ...live.tool, output: live.tool.output + event.text } },
    };
  }
  return { ...state, live: { ...live, [event.channel]: live[event.channel] + event.text } };
}

// `receivedAt` is this tab's clock when the event arrived, passed in so the fold stays pure.
export function foldEvent(
  state: ClientState,
  event: ServerEvent,
  receivedAt?: number,
): ClientState {
  switch (event.type) {
    case 'live':
      return {
        ...state,
        live: event.live,
        snapshotSeq: null,
        clockOffset: receivedAt === undefined ? state.clockOffset : event.now - receivedAt,
      };
    case 'delta':
      return foldDelta(state, event);
    default:
      return foldCommitted(state, event);
  }
}
