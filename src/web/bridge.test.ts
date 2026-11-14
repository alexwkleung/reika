import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../controller.js';
import type { Session, SubmitOptions } from '../session.js';
import { newSessionPath, projectHistoryDir, writeSession } from '../store/sessions.js';
import { TRANSCRIPT_VERSION } from '../store/transcript.js';
import type { Config, Message, Mode, Profile } from '../types.js';
import { createWebBridge } from './bridge.js';
import type { ServerEvent } from './protocol.js';

const user = (content: string): Message => ({ role: 'user', content });
const note = (content: string): Message => ({ role: 'system', content });
const profileOf = (model: string): Profile => ({
  model,
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
});

type Turn = (text: string, opts: SubmitOptions) => Promise<Message[]>;

// The parts of a session the controller and the bridge read, with a subscribe the bridge follows.
function fakeSession() {
  const cfg = {
    autoApprove: 'off',
    models: ['local'],
    profiles: { default: profileOf('local'), other: profileOf('other-model') },
  } as unknown as Config;
  const listeners = new Set<() => void>();
  let turn: Turn = async (text, opts) => {
    opts.onTurnStart?.();
    const bubble = user(opts.display ?? text);
    opts.events?.onMessage?.(bubble);
    opts.onTurnEnd?.();
    return [bubble];
  };
  const session = {
    profile: 'default',
    bundle: { cwd: '/repo/app', skills: [], fileIndex: [] },
    config: cfg,
    shrink: { sheds: 0, folds: 0 },
    lists: { agent: [], plan: [], chat: [], minimal: [], grind: [] },
    getSnapshot: () => ({ config: cfg }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set turn(next: Turn) {
      turn = next;
    },
    submit: vi.fn((text: string, opts: SubmitOptions) => turn(text, opts)),
    mcp: { call: vi.fn(), commands: [], list: vi.fn(() => '') },
    updateBundle: vi.fn(),
    switchSide: vi.fn(),
    loadHistory: vi.fn(),
    reset: vi.fn(),
    addProfile: vi.fn(),
    setProfile: vi.fn(async (name: string): Promise<Message[]> => {
      session.profile = name;
      for (const l of listeners) l();
      return [];
    }),
  };
  return session;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reika-bridge-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(mode: Mode = 'agent', opts: Parameters<typeof createWebBridge>[1] = {}) {
  const controller = createController({ mode, remember: vi.fn(), historyRoot: root });
  const session = fakeSession();
  controller.attachSession(session as unknown as Session, 'default');
  controller.setStatus('idle');
  const bridge = createWebBridge(controller, { now: () => 1000, ...opts });
  const events: ServerEvent[] = [];
  bridge.subscribe(e => events.push(e));
  return { controller, session, bridge, events };
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const types = (events: ServerEvent[]) => events.map(e => e.type);
const committed = (events: ServerEvent[]) => events.filter(e => 'seq' in e);
const lastLive = (events: ServerEvent[]) => {
  const live = events.filter(e => e.type === 'live').at(-1);
  if (live?.type !== 'live') throw new Error('no live event');
  return live.live;
};
const dialogs = (events: ServerEvent[]) => events.flatMap(e => (e.type === 'dialog' ? [e] : []));
const resolved = (events: ServerEvent[]) =>
  events.flatMap(e => (e.type === 'resolved' ? [{ id: e.id, outcome: e.outcome }] : []));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

describe('connect', () => {
  it('sends a fresh tab hello, reset, state and live, all at the newest seq', () => {
    const { bridge } = setup();
    const events = bridge.connect();
    expect(types(events)).toEqual(['hello', 'reset', 'state', 'live']);
    expect(committed(events).map(e => (e as { seq: number }).seq)).toEqual([0, 0, 0]);
    expect(events[2]).toMatchObject({ state: { mode: 'agent', status: 'idle', model: 'local' } });
  });
});

describe('committed events', () => {
  it('sends appended rows as messages, in order and numbered from one', () => {
    const { controller, events } = setup();
    controller.append(user('a'), note('b'));
    controller.append(note('c'));
    expect(events).toEqual([
      { type: 'message', seq: 1, message: user('a') },
      { type: 'message', seq: 2, message: note('b') },
      { type: 'message', seq: 3, message: note('c') },
    ]);
  });

  it('sends one reset for /new, a switch across the chat boundary and a replace', async () => {
    const { controller, bridge, events } = setup();
    controller.append(user('a'));
    events.length = 0;
    bridge.handle({ type: 'submit', text: '/new' });
    await flush();
    expect(types(events).filter(t => t === 'reset')).toHaveLength(1);
    expect(events.find(e => e.type === 'message')).toBeUndefined();

    events.length = 0;
    controller.transition('chat');
    expect(types(events).filter(t => t !== 'live')).toEqual(['reset', 'state']);

    controller.append(user('in chat'));
    events.length = 0;
    controller.replace([note('fresh')]);
    expect(events).toEqual([{ type: 'reset', seq: expect.any(Number), messages: [note('fresh')] }]);
  });

  it('sends state once when it changes and not for an unrelated change', () => {
    const { controller, events } = setup();
    controller.setStatus('busy');
    expect(types(events)).toEqual(['state']);
    events.length = 0;
    void controller.openConfirm({ title: 't', subtitle: 's', details: [], options: ['a'] });
    expect(types(events)).toEqual(['dialog']);
  });

  it('sends state for a change only the session reports', async () => {
    const { session, events } = setup();
    await session.setProfile('other');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'state',
        state: expect.objectContaining({ model: 'other-model', profile: 'other' }),
      }),
    ]);
  });

  it('follows a session that boots after the bridge was made', async () => {
    const controller = createController({ mode: 'agent', remember: vi.fn(), historyRoot: root });
    const bridge = createWebBridge(controller);
    const events: ServerEvent[] = [];
    bridge.subscribe(e => events.push(e));
    const session = fakeSession();
    controller.attachSession(session as unknown as Session, 'default');
    controller.setStatus('idle');
    expect(events.at(-1)).toMatchObject({ type: 'state', state: { model: 'local' } });
    await session.setProfile('other');
    expect(events.at(-1)).toMatchObject({ type: 'state', state: { model: 'other-model' } });
  });
});

describe('replay', () => {
  it('sends a reconnecting tab exactly what it missed, then live', () => {
    const { controller, bridge } = setup();
    controller.append(user('a'));
    controller.append(user('b'));
    controller.append(user('c'));
    const replay = bridge.connect(1);
    expect(replay).toEqual([
      { type: 'message', seq: 2, message: user('b') },
      { type: 'message', seq: 3, message: user('c') },
      { type: 'live', live: expect.any(Object) },
    ]);
  });

  it('lets a tab reconnect after a snapshot with no duplicates', () => {
    const { controller, bridge } = setup();
    controller.append(user('a'));
    const snapshot = bridge.connect();
    const seen = (snapshot[0] as { seq: number }).seq;
    controller.append(user('b'));
    expect(bridge.connect(seen)).toEqual([
      { type: 'message', seq: seen + 1, message: user('b') },
      { type: 'live', live: expect.any(Object) },
    ]);
  });

  it('sends a snapshot for a seq the bounded log no longer covers', () => {
    const { controller, bridge } = setup('agent', { maxLogEvents: 2 });
    for (const t of ['a', 'b', 'c', 'd']) controller.append(user(t));
    expect(types(bridge.connect(1))).toEqual(['hello', 'reset', 'state', 'live']);
    expect(types(bridge.connect(2))).toEqual(['message', 'message', 'live']);
    expect(types(bridge.connect(99))).toEqual(['hello', 'reset', 'state', 'live']);
  });

  it('sends only live to a tab that is up to date', () => {
    const { controller, bridge } = setup();
    controller.append(user('a'));
    expect(types(bridge.connect(1))).toEqual(['live']);
  });
});

describe('controller dialogs', () => {
  const request = { tool: 'bash', subject: 'Run', preview: 'ls' };

  it('opens an approval, lists it on connect, and answers it', () => {
    const { controller, bridge, events } = setup();
    const answered = controller.requestApproval(request);
    const [opened] = dialogs(events);
    expect(opened).toMatchObject({ id: 'd1', dialog: { kind: 'approval', preview: 'ls' } });
    expect(types(bridge.connect())).toEqual(['hello', 'reset', 'state', 'dialog', 'live']);

    expect(
      bridge.handle({ type: 'answer', id: 'd1', kind: 'approval', answer: true, always: true }),
    ).toEqual({ ok: true });
    expect(resolved(events)).toEqual([{ id: 'd1', outcome: 'answered' }]);
    expect(controller.getSnapshot().sessionAutoApprove).toBe(true);
    expect(types(bridge.connect())).not.toContain('dialog');
    return expect(answered).resolves.toBe(true);
  });

  it('refuses a wrong id or kind as a conflict and changes nothing', () => {
    const { controller, bridge } = setup();
    void controller.requestApproval(request);
    expect(
      bridge.handle({ type: 'answer', id: 'd9', kind: 'approval', answer: true }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(
      bridge.handle({ type: 'answer', id: 'd1', kind: 'question', answer: null }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(controller.approval).toEqual(request);
  });

  it('calls an approval resolved elsewhere cancelled, and a late answer a conflict', () => {
    const { controller, bridge, events } = setup();
    void controller.requestApproval(request);
    controller.answerApproval(false);
    expect(resolved(events)).toEqual([{ id: 'd1', outcome: 'cancelled' }]);
    expect(
      bridge.handle({ type: 'answer', id: 'd1', kind: 'approval', answer: true }),
    ).toMatchObject({ conflict: true });
  });

  it('answers a question, or calls it cancelled when closed elsewhere', async () => {
    const { controller, bridge, events } = setup();
    const asked = controller.openQuestion({ question: 'Which?', options: [{ label: 'A' }] });
    expect(dialogs(events)[0]).toMatchObject({
      id: 'd1',
      dialog: { kind: 'question', question: 'Which?' },
    });
    bridge.handle({ type: 'answer', id: 'd1', kind: 'question', answer: { text: 'A', index: 0 } });
    await expect(asked).resolves.toEqual({ text: 'A', index: 0 });

    void controller.openQuestion({ question: 'Again?', options: [] });
    controller.answerQuestion(null);
    expect(resolved(events)).toEqual([
      { id: 'd1', outcome: 'answered' },
      { id: 'd2', outcome: 'cancelled' },
    ]);
  });

  it("carries ask's initial row, 0 for a confirm the controller opened, and checks the choice", async () => {
    const { controller, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/approvals' });
    await flush();
    const [toggle] = dialogs(events);
    expect(toggle.dialog).toMatchObject({
      kind: 'confirm',
      options: ['on', 'off', 'Cancel'],
      initial: 1,
    });
    expect(bridge.handle({ type: 'answer', id: toggle.id, kind: 'confirm', choice: 3 })).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(bridge.handle({ type: 'answer', id: toggle.id, kind: 'confirm', choice: 0 })).toEqual({
      ok: true,
    });
    await flush();
    expect(controller.getSnapshot().sessionAutoApprove).toBe(true);

    const own = controller.openConfirm({
      title: 't',
      subtitle: 's',
      details: [],
      options: ['a', 'b'],
    });
    const [, second] = dialogs(events);
    expect(second.dialog).toMatchObject({ kind: 'confirm', initial: 0 });
    expect(
      bridge.handle({ type: 'answer', id: second.id, kind: 'confirm', choice: 'abort' }),
    ).toEqual({ ok: true });
    await expect(own).resolves.toBe('abort');
    expect(resolved(events).at(-1)).toEqual({ id: second.id, outcome: 'answered' });
  });
});

describe('pickers', () => {
  it('opens a model picker for a bare /model and picks, or dismisses, through it', async () => {
    const { controller, session, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    const [picker] = dialogs(events);
    expect(picker.dialog).toMatchObject({ kind: 'model' });
    expect(bridge.handle({ type: 'answer', id: picker.id, kind: 'model', name: 'other' })).toEqual({
      ok: true,
    });
    expect(session.setProfile).toHaveBeenCalledWith('other');
    expect(resolved(events)).toEqual([{ id: picker.id, outcome: 'answered' }]);

    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    const second = dialogs(events)[1];
    bridge.handle({ type: 'answer', id: second.id, kind: 'model', name: null });
    expect(session.setProfile).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({ content: '/model' });
  });

  it('cancels a picker superseded by a new one of the same kind', async () => {
    const { bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    expect(resolved(events)).toEqual([{ id: 'd1', outcome: 'cancelled' }]);
    expect(dialogs(events).map(d => d.id)).toEqual(['d1', 'd2']);
  });

  it('loads only a session the dialog offered, ending in a reset', async () => {
    const path = newSessionPath(projectHistoryDir('/repo/app', root), new Date(), 'saved');
    const turns = [user('fix the parser'), { role: 'assistant', content: 'done' } as Message];
    await writeSession(
      path,
      { agent: turns, chat: [] },
      {
        version: TRANSCRIPT_VERSION,
        savedAt: new Date().toISOString(),
        model: 'local',
        baseURL: 'http://127.0.0.1:1/v1',
        cwd: '/repo/app',
        messageCount: turns.length,
        mode: 'agent',
      },
    );
    const { controller, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/resume' });
    // Listing reads the history directory.
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(1));
    const [picker] = dialogs(events);
    expect(picker.dialog).toMatchObject({
      kind: 'session',
      entries: [expect.objectContaining({ path })],
    });

    expect(
      bridge.handle({ type: 'answer', id: picker.id, kind: 'session', path: '/etc/passwd' }),
    ).toEqual({ ok: false, error: expect.any(String) });
    expect(bridge.handle({ type: 'answer', id: picker.id, kind: 'session', path })).toEqual({
      ok: true,
    });
    // The TUI leaves a prompt in the box while a resume loads; a tab keeps it the same way.
    expect(bridge.handle({ type: 'submit', text: 'too soon' })).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(types(events)).toContain('reset'));
    expect(controller.messages.slice(0, 2)).toEqual(turns);
  });

  it('reports a failed load in the scrollback', async () => {
    const path = newSessionPath(projectHistoryDir('/repo/app', root), new Date(), 'saved');
    await writeSession(
      path,
      { agent: [user('x')], chat: [] },
      {
        version: TRANSCRIPT_VERSION,
        savedAt: new Date().toISOString(),
        model: 'local',
        baseURL: 'http://127.0.0.1:1/v1',
        cwd: '/repo/app',
        messageCount: 1,
        mode: 'agent',
      },
    );
    const { controller, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/resume' });
    // Listing reads the history directory.
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(1));
    const [picker] = dialogs(events);
    await rm(path);
    bridge.handle({ type: 'answer', id: picker.id, kind: 'session', path });
    await vi.waitFor(() =>
      expect(controller.messages.at(-1)).toMatchObject({
        role: 'error',
        content: expect.stringMatching(/^resume failed: /),
      }),
    );
  });
});

describe('live', () => {
  it('streams a turn: deltas, live for the rest, and clears at commits and turn end', async () => {
    const { session, bridge, events } = setup();
    const gate = deferred();
    const steps = [{ n: 1, text: 'edit', paths: [], commands: [], snippets: [], done: false }];
    session.turn = async (text, opts) => {
      opts.onTurnStart?.();
      const ev = opts.events!;
      ev.onMessage!(user(text));
      ev.onPhase!('thinking');
      ev.onReasoningDelta!('let me ');
      ev.onReasoningDelta!('see');
      ev.onContentDelta!('Hi');
      ev.onPlanProgress!(steps as never);
      await gate.promise;
      ev.onMessage!({ role: 'assistant', content: 'Hi' });
      ev.onToolStart!('bash');
      ev.onToolProgress!('out', 'bash');
      ev.onToolProgress!('put', 'bash');
      ev.onToolProgress!('x', 'grep');
      ev.onMessage!({ role: 'tool', callId: 'c1', summary: 'Ran: ls' });
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    expect(events.filter(e => e.type === 'delta')).toEqual([
      { type: 'delta', channel: 'reasoning', text: 'let me ' },
      { type: 'delta', channel: 'reasoning', text: 'see' },
      { type: 'delta', channel: 'content', text: 'Hi' },
    ]);
    const mid = bridge.connect().at(-1);
    expect(mid).toMatchObject({
      type: 'live',
      live: { phase: 'thinking', reasoning: 'let me see', content: 'Hi' },
    });
    // The loop mutates its array in place.
    steps[0].done = true;
    expect(lastLive(bridge.connect()).plan).toEqual([expect.objectContaining({ done: false })]);

    events.length = 0;
    gate.resolve();
    await flush();
    const lives = events.flatMap(e => (e.type === 'live' ? [e.live] : []));
    expect(lives[0]).toMatchObject({ content: '', reasoning: '' });
    expect(lives[1]).toMatchObject({ pending: { name: 'bash', since: 1000 } });
    expect(lives[2]).toMatchObject({ tool: { name: 'bash', output: 'out' } });
    expect(events).toContainEqual({ type: 'delta', channel: 'tool', text: 'put' });
    expect(lives[3]).toMatchObject({ tool: { name: 'grep', output: 'x' } });
    expect(lives[4]).toMatchObject({ tool: null, pending: null });
    expect(lastLive(events)).toMatchObject({
      phase: null,
      content: '',
      tool: null,
      plan: [expect.any(Object)],
    });
  });

  it('hides the pending call while an approval is open and shows it after', async () => {
    const { session, bridge, events } = setup();
    const answered = deferred<unknown>();
    session.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onToolStart!('bash');
      answered.resolve(
        await opts.requestApproval!({ tool: 'bash', subject: 'Run', preview: 'ls' }),
      );
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    expect(lastLive(events).pending).toBeNull();
    expect(lastLive(bridge.connect()).pending).toBeNull();
    bridge.handle({ type: 'answer', id: 'd1', kind: 'approval', answer: true });
    expect(lastLive(events).pending).toEqual({ name: 'bash', since: 1000 });
    await expect(answered.promise).resolves.toBe(true);
  });

  it('freezes the stream on a reasoning reset and clears it', async () => {
    const { controller, session, bridge, events } = setup();
    session.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onSubagent!(true);
      opts.events!.onReasoningDelta!('round and round');
      opts.events!.onReasoningReset!();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    expect(controller.messages.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      reasoning: 'round and round',
      discarded: 'stream',
      nested: true,
    });
    expect(lastLive(events)).toMatchObject({ reasoning: '', content: '', subagent: true });
  });
});

describe('input', () => {
  it('submits a prompt, queues one while busy, and replays it once idle', async () => {
    const { session, bridge, events } = setup();
    const gate = deferred();
    session.turn = async (text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onMessage!(user(text));
      if (text === 'first') await gate.promise;
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'first' });
    await flush();
    bridge.handle({ type: 'submit', text: 'second' });
    await flush();
    const queued = events.filter(e => e.type === 'state').at(-1);
    expect(queued).toMatchObject({ state: { queue: [{ content: 'second', images: 0 }] } });
    gate.resolve();
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2));
    expect(session.submit.mock.calls.map(c => c[0])).toEqual(['first', 'second']);
  });

  it('aborts a running turn', async () => {
    const { session, bridge } = setup();
    let signal: AbortSignal | undefined;
    session.turn = async (_text, opts) => {
      signal = opts.onTurnStart?.() ?? undefined;
      await new Promise(resolve => signal!.addEventListener('abort', resolve));
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    expect(bridge.handle({ type: 'abort' })).toEqual({ ok: true });
    expect(signal?.aborted).toBe(true);
    expect(bridge.handle({ type: 'abort' })).toEqual({ ok: true });
  });

  it('calls onExit for /exit', async () => {
    const onExit = vi.fn();
    const { bridge } = setup('agent', { onExit });
    bridge.handle({ type: 'submit', text: '/exit' });
    await flush();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('appends an error when the submit rejects', async () => {
    const { controller, bridge } = setup();
    vi.spyOn(controller, 'submit').mockRejectedValueOnce(new Error('boom'));
    expect(bridge.handle({ type: 'submit', text: 'go' })).toEqual({ ok: true });
    await flush();
    expect(controller.messages.at(-1)).toEqual({ role: 'error', content: 'boom' });
  });
});

describe('close', () => {
  it('cancels open pickers, then sends nothing more', async () => {
    const { controller, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    bridge.close();
    expect(resolved(events)).toEqual([{ id: 'd1', outcome: 'cancelled' }]);
    const before = events.length;
    controller.append(user('after'));
    controller.setStatus('busy');
    expect(events).toHaveLength(before);
  });

  it('drops a listener that throws, and keeps the controller and the other listeners going', () => {
    const { controller, bridge, events } = setup();
    let calls = 0;
    bridge.subscribe(() => {
      calls++;
      throw new Error('socket closed');
    });
    const before = events.length;
    expect(() => controller.append(user('first'))).not.toThrow();
    controller.append(user('second'));
    expect(calls).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(before + 2);
    expect(controller.messages).toHaveLength(2);
  });
});
