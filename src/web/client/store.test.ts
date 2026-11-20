import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ServerEvent,
  type WireDialog,
  type WireLive,
  type WireMessage,
  type WireState,
} from '../protocol.js';
import { foldEvent, initialClientState, type ClientState } from './store.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Every fold in these tests runs on a frozen input, so a mutation throws.
function fold(state: ClientState, ...events: ServerEvent[]): ClientState {
  return events.reduce((s, e) => foldEvent(deepFreeze(s), deepFreeze(e)), state);
}

const user = (content: string): WireMessage => ({ role: 'user', content });

const wireState = (over: Partial<WireState> = {}): WireState => ({
  mode: 'agent',
  status: 'idle',
  error: null,
  model: 'local-model',
  profile: 'default',
  cwd: '/repo',
  autoApprove: 'safe',
  unattended: false,
  usage: { promptTokens: 0, completionTokens: 0 },
  lastUsage: null,
  estimatedContext: null,
  contextWindow: null,
  contextUsable: null,
  shrink: { sheds: 0, folds: 0 },
  decodeRate: null,
  queue: [],
  approvals: { approved: 0, declined: 0 },
  preparing: false,
  stage: null,
  modelPinned: false,
  session: null,
  offScreen: null,
  workingWords: false,
  pr: null,
  ...over,
});

const live = (over: Partial<WireLive> = {}): WireLive => ({
  phase: null,
  content: '',
  reasoning: '',
  tool: null,
  pending: null,
  plan: null,
  usage: null,
  subagent: false,
  note: false,
  typechecking: false,
  recovering: false,
  promptProgress: null,
  looping: false,
  ...over,
});

const question: WireDialog = { kind: 'question', question: 'which?', options: [{ label: 'a' }] };
const approval: WireDialog = { kind: 'approval', tool: 'bash', subject: 'ls', preview: 'ls' };

// What bridge.connect() sends a fresh tab: every event at the newest seq, then live.
function snapshot(
  seq: number,
  opts: { messages?: WireMessage[]; dialogs?: [string, WireDialog][] } = {},
): ServerEvent[] {
  return [
    { type: 'hello', seq, version: PROTOCOL_VERSION },
    { type: 'reset', seq, messages: opts.messages ?? [] },
    { type: 'state', seq, state: wireState() },
    ...(opts.dialogs ?? []).map(([id, dialog]): ServerEvent => ({
      type: 'dialog',
      seq,
      id,
      dialog,
    })),
    { type: 'live', now: 0, live: live() },
  ];
}

describe('foldEvent: a snapshot', () => {
  it('takes every event of a snapshot even though they share one seq', () => {
    const s = fold(
      initialClientState,
      ...snapshot(7, {
        messages: [user('a')],
        dialogs: [
          ['d1', question],
          ['d2', approval],
        ],
      }),
    );
    expect(s.messages).toEqual([user('a')]);
    expect(s.session?.model).toBe('local-model');
    expect(s.dialogs.map(d => d.id)).toEqual(['d1', 'd2']);
    expect(s.live).toEqual(live());
    expect(s.lastSeq).toBe(7);
    expect(s.snapshotSeq).toBeNull();
  });

  it('ends at the live event, after which the shared seq is a duplicate again', () => {
    const s = fold(initialClientState, ...snapshot(3));
    const again = fold(s, { type: 'message', seq: 3, message: user('dup') });
    expect(again).toBe(s);
  });

  it('ends early at a newer committed event', () => {
    const s = fold(
      initialClientState,
      { type: 'hello', seq: 2, version: PROTOCOL_VERSION },
      { type: 'message', seq: 3, message: user('new') },
      { type: 'message', seq: 2, message: user('old') },
    );
    expect(s.messages).toEqual([user('new')]);
    expect(s.snapshotSeq).toBeNull();
  });

  it('replaces the dialogs and live of an earlier connection, and keeps the transcript for the reset', () => {
    const before = fold(
      initialClientState,
      ...snapshot(1, { messages: [user('a')], dialogs: [['d1', question]] }),
      { type: 'live', now: 0, live: live({ content: 'streaming' }) },
    );
    const hello = fold(before, { type: 'hello', seq: 5, version: PROTOCOL_VERSION });
    expect(hello.dialogs).toEqual([]);
    expect(hello.live).toBeNull();
    expect(hello.messages).toBe(before.messages);
    const after = fold(
      hello,
      ...snapshot(5, { messages: [user('b')], dialogs: [['d4', approval]] }).slice(1),
    );
    expect(after.messages).toEqual([user('b')]);
    expect(after.dialogs.map(d => d.id)).toEqual(['d4']);
  });

  it('is taken from a server that restarted with lower seqs', () => {
    const before = fold(initialClientState, ...snapshot(40, { messages: [user('old')] }));
    const after = fold(before, ...snapshot(0, { messages: [user('fresh')] }));
    expect(after.messages).toEqual([user('fresh')]);
    expect(after.lastSeq).toBe(0);
    expect(fold(after, { type: 'message', seq: 1, message: user('next') }).messages).toHaveLength(
      2,
    );
  });
});

describe('foldEvent: replay overlap', () => {
  it('ignores committed events not newer than the last one taken', () => {
    let s = fold(initialClientState, ...snapshot(0));
    s = fold(
      s,
      { type: 'message', seq: 1, message: user('one') },
      { type: 'message', seq: 2, message: user('two') },
    );
    // A reconnect resumed from seq 1 replays 2 again.
    const replayed = fold(
      s,
      { type: 'message', seq: 2, message: user('two') },
      { type: 'message', seq: 1, message: user('one') },
      { type: 'state', seq: 2, state: wireState({ mode: 'plan' }) },
    );
    expect(replayed).toBe(s);
    const next = fold(s, { type: 'message', seq: 3, message: user('three') });
    expect(next.messages).toEqual([user('one'), user('two'), user('three')]);
    expect(next.lastSeq).toBe(3);
  });

  it('takes anything before a first seq is known', () => {
    const s = fold(initialClientState, { type: 'message', seq: 9, message: user('x') });
    expect(s.messages).toEqual([user('x')]);
    expect(s.lastSeq).toBe(9);
  });

  it('a stale dialog or resolved changes nothing', () => {
    const s = fold(initialClientState, ...snapshot(4, { dialogs: [['d1', question]] }));
    expect(fold(s, { type: 'resolved', seq: 4, id: 'd1', outcome: 'answered' })).toBe(s);
    expect(fold(s, { type: 'dialog', seq: 3, id: 'd9', dialog: approval })).toBe(s);
  });
});

describe('foldEvent: committed events', () => {
  const base = fold(initialClientState, ...snapshot(0, { messages: [user('a')] }));

  it('message appends', () => {
    const s = fold(base, { type: 'message', seq: 1, message: user('b') });
    expect(s.messages).toEqual([user('a'), user('b')]);
  });

  it('reset replaces the messages and leaves dialogs, live and session alone', () => {
    const withDialog = fold(
      base,
      { type: 'dialog', seq: 1, id: 'd1', dialog: question },
      { type: 'live', now: 0, live: live({ content: 'x' }) },
    );
    const s = fold(withDialog, { type: 'reset', seq: 2, messages: [user('z')] });
    expect(s.messages).toEqual([user('z')]);
    expect(s.dialogs).toBe(withDialog.dialogs);
    expect(s.live).toBe(withDialog.live);
    expect(s.session).toBe(withDialog.session);
  });

  it('counts a replaced conversation, but not the redraw a reconnect snapshot opens with', () => {
    const joined = fold(base, ...snapshot(1, { messages: [user('a')] }));
    expect(joined.replaced).toBe(0);
    const resumed = fold(joined, { type: 'reset', seq: 2, messages: [user('b')] });
    expect(resumed.replaced).toBe(1);
    const reconnected = fold(resumed, ...snapshot(3, { messages: [user('b')] }));
    expect(reconnected.replaced).toBe(1);
  });

  it('state replaces the session', () => {
    const s = fold(base, {
      type: 'state',
      seq: 1,
      state: wireState({ mode: 'plan', status: 'busy' }),
    });
    expect(s.session?.mode).toBe('plan');
    expect(s.session?.status).toBe('busy');
    expect(s.messages).toBe(base.messages);
  });

  it('dialogs stack in arrival order and resolved removes the one named', () => {
    let s = fold(
      base,
      { type: 'dialog', seq: 1, id: 'd1', dialog: question },
      { type: 'dialog', seq: 2, id: 'd2', dialog: approval },
      { type: 'dialog', seq: 3, id: 'd3', dialog: question },
    );
    expect(s.dialogs.map(d => d.id)).toEqual(['d1', 'd2', 'd3']);
    s = fold(s, { type: 'resolved', seq: 4, id: 'd2', outcome: 'cancelled' });
    expect(s.dialogs.map(d => d.id)).toEqual(['d1', 'd3']);
    s = fold(s, { type: 'resolved', seq: 5, id: 'd1', outcome: 'answered' });
    expect(s.dialogs.map(d => d.id)).toEqual(['d3']);
  });

  it('a dialog sent again under its id is replaced in place', () => {
    const s = fold(
      base,
      { type: 'dialog', seq: 1, id: 'd1', dialog: question },
      { type: 'dialog', seq: 2, id: 'd2', dialog: question },
      { type: 'dialog', seq: 3, id: 'd1', dialog: approval },
    );
    expect(s.dialogs).toEqual([
      { id: 'd1', dialog: approval },
      { id: 'd2', dialog: question },
    ]);
  });

  it('resolved for an unknown id keeps the dialogs array and advances the seq', () => {
    const s = fold(base, { type: 'resolved', seq: 1, id: 'nope', outcome: 'answered' });
    expect(s.dialogs).toBe(base.dialogs);
    expect(s.lastSeq).toBe(1);
  });

  it('catalog replaces the model list', () => {
    const models = [
      {
        name: 'default',
        model: 'local',
        baseURL: 'http://127.0.0.1:1/v1',
        kind: 'model' as const,
        active: true,
      },
    ];
    expect(fold(base, { type: 'catalog', seq: 1, catalog: { models } }).catalog).toEqual({
      models,
    });
  });

  it('history replaces the list and historyAdd appends one line', () => {
    const s = fold(
      base,
      { type: 'history', seq: 1, entries: ['one'] },
      { type: 'historyAdd', seq: 2, entry: 'two' },
    );
    expect(s.history).toEqual(['one', 'two']);
    expect(fold(s, { type: 'history', seq: 3, entries: ['fresh'] }).history).toEqual(['fresh']);
  });

  it('an event this page does not know is taken for its seq and changes nothing else', () => {
    const unknown = { type: 'from-the-future', seq: 1, payload: 1 } as unknown as ServerEvent;
    const s = fold(base, unknown);
    expect(s).toEqual({ ...base, lastSeq: 1, snapshotSeq: null });
  });
});

describe('foldEvent: live and deltas', () => {
  const base = fold(initialClientState, ...snapshot(0, { messages: [user('a')] }));

  it('live replaces the live turn and keeps every other field by identity', () => {
    const s = fold(base, { type: 'live', now: 0, live: live({ phase: 'thinking' }) });
    expect(s.live?.phase).toBe('thinking');
    expect(s.messages).toBe(base.messages);
    expect(s.dialogs).toBe(base.dialogs);
    expect(s.session).toBe(base.session);
  });

  it('content and reasoning deltas append to their channel', () => {
    const s = fold(
      base,
      { type: 'delta', channel: 'content', text: 'Hel' },
      { type: 'delta', channel: 'content', text: 'lo' },
      { type: 'delta', channel: 'reasoning', text: 'hmm' },
    );
    expect(s.live?.content).toBe('Hello');
    expect(s.live?.reasoning).toBe('hmm');
    expect(s.messages).toBe(base.messages);
    expect(s.lastSeq).toBe(base.lastSeq);
  });

  it('a tool delta appends to the block on screen', () => {
    const s = fold(
      base,
      { type: 'live', now: 0, live: live({ tool: { name: 'bash', output: 'a\n' } }) },
      { type: 'delta', channel: 'tool', text: 'b\n' },
    );
    expect(s.live?.tool).toEqual({ name: 'bash', output: 'a\nb\n' });
  });

  it('a delta takes back what drop names before it appends (#990)', () => {
    const s = fold(
      base,
      { type: 'live', now: 0, live: live({ tool: { name: 'bash', output: '10%' } }) },
      { type: 'delta', channel: 'content', text: 'by Mona ' },
      { type: 'delta', channel: 'content', text: '<user> today ', drop: 5 },
      { type: 'delta', channel: 'tool', text: '50%', drop: 3 },
    );
    expect(s.live?.content).toBe('by <user> today ');
    expect(s.live?.tool?.output).toBe('50%');
  });

  it('a tool delta with no tool block is dropped', () => {
    expect(fold(base, { type: 'delta', channel: 'tool', text: 'x' })).toBe(base);
  });

  it('a delta before any live snapshot is dropped', () => {
    expect(fold(initialClientState, { type: 'delta', channel: 'content', text: 'x' })).toBe(
      initialClientState,
    );
  });

  it('a delta after a hello and before its live is dropped', () => {
    const s = fold(base, { type: 'hello', seq: 1, version: PROTOCOL_VERSION });
    expect(fold(s, { type: 'delta', channel: 'content', text: 'x' })).toBe(s);
  });
});

describe('foldEvent: version', () => {
  it('records a hello whose version differs, and clears it on one that matches', () => {
    const s = fold(initialClientState, { type: 'hello', seq: 0, version: PROTOCOL_VERSION + 1 });
    expect(s.versionMismatch).toBe(PROTOCOL_VERSION + 1);
    expect(
      fold(s, { type: 'hello', seq: 1, version: PROTOCOL_VERSION }).versionMismatch,
    ).toBeNull();
  });
});

describe('foldEvent: the server clock', () => {
  it('measures the offset at each live event, and keeps it when no arrival time is given', () => {
    let s = foldEvent(initialClientState, { type: 'live', now: 50_000, live: live() }, 20_000);
    expect(s.clockOffset).toBe(30_000);
    s = foldEvent(s, { type: 'live', now: 51_000, live: live() }, 21_500);
    expect(s.clockOffset).toBe(29_500);
    s = foldEvent(s, { type: 'live', now: 0, live: live() });
    expect(s.clockOffset).toBe(29_500);
  });
});
