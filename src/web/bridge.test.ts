import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../controller.js';
import type { Session, SubmitOptions } from '../session.js';
import { newSessionPath, projectHistoryDir, writeSession } from '../store/sessions.js';
import { TRANSCRIPT_VERSION } from '../store/transcript.js';
import type { Config, Message, Mode, Profile } from '../types.js';
import { clearIdentity, setIdentity } from '../ui/identity.js';
import { createWebBridge } from './bridge.js';
import { MAX_LISTED_SESSIONS, sessionId, type ServerEvent } from './protocol.js';
import type * as PastedUrls from '../agent/pastedurls.js';

// A pasted-link fetch that announces itself and waits for the test to let it finish.
const linkFetch = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('../agent/pastedurls.js', async importOriginal => {
  const real = await importOriginal<typeof PastedUrls>();
  return {
    ...real,
    expandPastedUrls: async (...args: Parameters<typeof real.expandPastedUrls>) => {
      if (!linkFetch.gate) return real.expandPastedUrls(...args);
      args[1].onStart?.(1);
      await linkFetch.gate;
      return { blocks: ['<url href="stub">the page</url>'], notices: [], fetched: [] };
    },
  };
});

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
  const controller = createController({
    mode,
    remember: vi.fn(),
    historyRoot: root,
    now: () => 1000,
  });
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
  it('sends a fresh tab hello, reset, state, catalog, history and live, all at the newest seq', () => {
    const { bridge } = setup();
    const events = bridge.connect();
    expect(types(events)).toEqual(['hello', 'reset', 'state', 'catalog', 'history', 'live']);
    expect(committed(events).map(e => (e as { seq: number }).seq)).toEqual([0, 0, 0, 0, 0]);
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

  it('sends state and the model list for a change only the session reports', async () => {
    const { session, events } = setup();
    await session.setProfile('other');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'state',
        state: expect.objectContaining({ model: 'other-model', profile: 'other' }),
      }),
      expect.objectContaining({
        type: 'catalog',
        catalog: {
          models: expect.arrayContaining([
            expect.objectContaining({ name: 'other', active: true }),
          ]),
        },
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
    const states = () => events.filter(e => e.type === 'state');
    expect(states().at(-1)).toMatchObject({ state: { model: 'local' } });
    await session.setProfile('other');
    expect(states().at(-1)).toMatchObject({ state: { model: 'other-model' } });
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
      { type: 'live', live: expect.any(Object), now: 1000 },
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
      { type: 'live', live: expect.any(Object), now: 1000 },
    ]);
  });

  it('sends a snapshot for a seq the bounded log no longer covers', () => {
    const { controller, bridge } = setup('agent', { maxLogEvents: 2 });
    for (const t of ['a', 'b', 'c', 'd']) controller.append(user(t));
    expect(types(bridge.connect(1))).toEqual([
      'hello',
      'reset',
      'state',
      'catalog',
      'history',
      'live',
    ]);
    expect(types(bridge.connect(2))).toEqual(['message', 'message', 'live']);
    expect(types(bridge.connect(99))).toEqual([
      'hello',
      'reset',
      'state',
      'catalog',
      'history',
      'live',
    ]);
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
    expect(types(bridge.connect())).toEqual([
      'hello',
      'reset',
      'state',
      'catalog',
      'history',
      'dialog',
      'live',
    ]);

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

  it('takes only a model the picker offered, and not while a turn runs (#995)', async () => {
    const { controller, session, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    const [picker] = dialogs(events);
    for (const name of ['anything', '']) {
      expect(bridge.handle({ type: 'answer', id: picker.id, kind: 'model', name })).toEqual({
        ok: false,
        error: 'name is not one this dialog offered',
      });
    }
    controller.setStatus('busy');
    expect(bridge.handle({ type: 'answer', id: picker.id, kind: 'model', name: 'other' })).toEqual({
      ok: false,
      error: 'cannot switch while busy',
    });
    expect(session.setProfile).not.toHaveBeenCalled();
    expect(session.addProfile).not.toHaveBeenCalled();
    expect(resolved(events)).toEqual([]);

    controller.setStatus('idle');
    expect(bridge.handle({ type: 'answer', id: picker.id, kind: 'model', name: 'other' })).toEqual({
      ok: true,
    });
    expect(session.setProfile).toHaveBeenCalledWith('other');
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
      entries: [expect.objectContaining({ id: sessionId(path) })],
    });
    expect(JSON.stringify(picker.dialog)).not.toContain(path);

    expect(
      bridge.handle({ type: 'answer', id: picker.id, kind: 'session', session: 'other.jsonl' }),
    ).toEqual({ ok: false, error: expect.any(String) });
    expect(
      bridge.handle({ type: 'answer', id: picker.id, kind: 'session', session: sessionId(path) }),
    ).toEqual({ ok: true });
    // The TUI leaves a prompt in the box while a resume loads; a tab keeps it the same way.
    expect(bridge.handle({ type: 'submit', text: 'too soon' })).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(types(events)).toContain('reset'));
    expect(controller.messages.slice(0, 2)).toEqual(turns);
  });

  it('refuses a resume while a line is prepared, queued or asked about, or a turn runs (#1004)', async () => {
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
    const { controller, session, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/resume' });
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(1));
    const [picker] = dialogs(events);
    const pick = () =>
      bridge.handle({ type: 'answer', id: picker.id, kind: 'session', session: sessionId(path) });
    const refused = { ok: false, conflict: true };

    // A line held before its turn starts: preparing, with the status still idle.
    const gate = deferred();
    session.turn = async (text, opts) => {
      await gate.promise;
      opts.onTurnStart?.();
      opts.events?.onMessage?.(user(text));
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'first' });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', preparing: true });
    expect(pick()).toMatchObject(refused);
    gate.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().preparing).toBe(false));

    controller.setStatus('busy');
    expect(pick()).toMatchObject(refused);
    controller.setStatus('idle');

    const asked = controller.openConfirm({
      title: 't',
      subtitle: 's',
      details: [],
      options: ['a'],
    });
    expect(pick()).toMatchObject(refused);
    controller.answerConfirm(0);
    await asked;

    controller.enqueue({ content: 'later', answers: {} });
    expect(pick()).toMatchObject(refused);
    expect(types(events)).not.toContain('reset');
    // The picker stays open for a resume once the session is between prompts again.
    expect(resolved(events).some(r => r.id === picker.id)).toBe(false);
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
    bridge.handle({ type: 'answer', id: picker.id, kind: 'session', session: sessionId(path) });
    await vi.waitFor(() =>
      expect(controller.messages.at(-1)).toMatchObject({
        role: 'error',
        content: expect.stringMatching(/^resume failed: /),
      }),
    );
  });
});

describe('history drawer', () => {
  const project = () => projectHistoryDir('/repo/app', root);
  // A session file whose title is its first prompt, saved `ago` ms before now.
  async function saved(dir: string, stem: string, prompt: string, ago = 0): Promise<string> {
    const path = newSessionPath(dir, new Date(), stem);
    const turns = [user(prompt), { role: 'assistant', content: 'done' } as Message];
    await writeSession(
      path,
      { agent: turns, chat: [] },
      {
        version: TRANSCRIPT_VERSION,
        savedAt: new Date(Date.now() - ago).toISOString(),
        model: 'local',
        baseURL: 'http://127.0.0.1:1/v1',
        cwd: '/repo/app',
        messageCount: turns.length,
        mode: 'agent',
      },
    );
    return path;
  }
  const list = async (bridge: ReturnType<typeof setup>['bridge'], filter?: string) => {
    const result = await bridge.handle({
      type: 'sessions',
      scope: 'project',
      ...(filter !== undefined ? { filter } : {}),
    });
    if (!result.ok || !result.reply || !('scope' in result.reply)) throw new Error('no list');
    return result.reply;
  };
  const resumeTo = (bridge: ReturnType<typeof setup>['bridge'], id: string) =>
    Promise.resolve(bridge.handle({ type: 'resume', scope: 'project', id }));

  it('lists the project newest first by id, while busy, with no root fallback or paths', async () => {
    await saved(project(), 'older', 'fix the parser', 60_000);
    await saved(project(), 'newer', 'rename foo to bar');
    const { controller, bridge } = setup();
    controller.setStatus('busy');
    const reply = await list(bridge);
    expect(reply).toMatchObject({ scope: 'project', total: 2, autosave: false });
    expect(reply.entries.map(e => [e.id, e.title])).toEqual([
      ['newer.jsonl', 'rename foo to bar'],
      ['older.jsonl', 'fix the parser'],
    ]);
    expect(JSON.stringify(reply)).not.toContain(root);

    // An empty project lists nothing, where `/resume` would offer the /save files.
    await rm(project(), { recursive: true });
    await saved(root, 'manual', 'a save');
    expect(await list(bridge)).toMatchObject({ entries: [], total: 0 });
    const roots = await bridge.handle({ type: 'sessions', scope: 'root' });
    expect(roots).toMatchObject({ ok: true, reply: { entries: [{ id: 'manual.jsonl' }] } });
  });

  it('filters titles on the server and caps the list, counting every match', async () => {
    for (let i = 0; i < MAX_LISTED_SESSIONS + 3; i++) {
      await saved(project(), `s${String(i).padStart(3, '0')}`, i % 2 ? 'Parser work' : 'other', i);
    }
    const { bridge } = setup();
    const all = await list(bridge);
    expect(all.entries).toHaveLength(MAX_LISTED_SESSIONS);
    expect(all.total).toBe(MAX_LISTED_SESSIONS + 3);
    const parser = await list(bridge, '  parser ');
    expect(parser.total).toBe(Math.floor((MAX_LISTED_SESSIONS + 3) / 2));
    expect(parser.entries.every(e => e.title === 'Parser work')).toBe(true);
  });

  it('resumes by id from a fresh list, then marks it current and refuses it again', async () => {
    await saved(project(), 'a', 'fix the parser');
    const { controller, bridge, events } = setup();
    expect(await resumeTo(bridge, 'a.jsonl')).toEqual({ ok: true });
    expect(controller.messages[0]).toMatchObject({ content: 'fix the parser' });
    const state = events.filter(e => e.type === 'state').at(-1);
    expect(state).toMatchObject({ state: { session: 'a.jsonl' } });
    expect((await list(bridge)).entries).toEqual([
      expect.objectContaining({ id: 'a.jsonl', current: true }),
    ]);
    expect(await resumeTo(bridge, 'a.jsonl')).toMatchObject({ ok: false, conflict: true });
  });

  it('refuses an id the fresh list does not hold, and reads nothing', async () => {
    const path = await saved(project(), 'gone', 'x');
    const { controller, bridge, events } = setup();
    await rm(path);
    expect(await resumeTo(bridge, 'gone.jsonl')).toMatchObject({ ok: false, conflict: true });
    expect(await resumeTo(bridge, 'never.jsonl')).toMatchObject({ ok: false, conflict: true });
    expect(types(events)).not.toContain('reset');
    expect(controller.messages.some(m => m.role === 'error')).toBe(false);
  });

  it('loads exactly one of two resumes sent together', async () => {
    await saved(project(), 'a', 'first');
    await saved(project(), 'b', 'second');
    const { controller, bridge } = setup();
    const [one, two] = await Promise.all([
      resumeTo(bridge, 'a.jsonl'),
      resumeTo(bridge, 'b.jsonl'),
    ]);
    expect(one).toEqual({ ok: true });
    expect(two).toMatchObject({ ok: false, conflict: true });
    expect(controller.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual([
      'first',
    ]);
  });

  it('refuses a resume or a new conversation unless between prompts', async () => {
    await saved(project(), 'a', 'x');
    const { controller, bridge, events } = setup();
    const refused = { ok: false, conflict: true };

    controller.setStatus('busy');
    expect(await resumeTo(bridge, 'a.jsonl')).toMatchObject(refused);
    expect(bridge.handle({ type: 'new' })).toMatchObject(refused);
    controller.setStatus('idle');

    const asked = controller.openConfirm({
      title: 't',
      subtitle: 's',
      details: [],
      options: ['a'],
    });
    expect(await resumeTo(bridge, 'a.jsonl')).toMatchObject(refused);
    expect(bridge.handle({ type: 'new' })).toMatchObject(refused);
    controller.answerConfirm(0);
    await asked;

    controller.enqueue({ content: 'later', answers: {} });
    expect(await resumeTo(bridge, 'a.jsonl')).toMatchObject(refused);
    expect(bridge.handle({ type: 'new' })).toMatchObject(refused);
    expect(types(events)).not.toContain('reset');
    // Refused rather than queued: no `/new` echo and no resumed rows, now or after the replay.
    await flush();
    const contents = controller.messages.map(m => ('content' in m ? m.content : ''));
    expect(contents).not.toContain('/new');
    expect(contents).not.toContain('x');
  });

  it('starts a new conversation as /new does, closing an open /resume picker', async () => {
    await saved(project(), 'a', 'x');
    const { controller, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/resume' });
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(1));
    const [picker] = dialogs(events);
    expect(bridge.handle({ type: 'new' })).toEqual({ ok: true });
    expect(resolved(events)).toContainEqual({ id: picker.id, outcome: 'cancelled' });
    expect(controller.messages[0]).toEqual({ role: 'user', content: '/new', meta: true });
    expect(controller.getSnapshot().history).toEqual(['/resume']);
  });

  it('closes an open /resume picker on a drawer resume, and refuses its pick of the open session', async () => {
    await saved(project(), 'a', 'first');
    const b = await saved(project(), 'b', 'second');
    const { bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/resume' });
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(1));
    const [stale] = dialogs(events);
    expect(await resumeTo(bridge, 'b.jsonl')).toEqual({ ok: true });
    expect(resolved(events)).toContainEqual({ id: stale.id, outcome: 'cancelled' });

    // A picker listed before the drawer opened `b` must not open it a second time.
    bridge.handle({ type: 'submit', text: '/resume all' });
    await vi.waitFor(() => expect(dialogs(events)).toHaveLength(2));
    const picker = dialogs(events)[1];
    const offered = picker.dialog.kind === 'session' ? picker.dialog.entries : [];
    expect(offered.some(e => e.id === sessionId(b))).toBe(false);
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
      ev.onReasoningDelta!('see ');
      ev.onContentDelta!('Hi ');
      ev.onPlanProgress!(steps as never);
      await gate.promise;
      ev.onMessage!({ role: 'assistant', content: 'Hi' });
      ev.onToolStart!('bash');
      ev.onToolProgress!('out\n', 'bash');
      ev.onToolProgress!('put\n', 'bash');
      ev.onToolProgress!('x\n', 'grep');
      ev.onMessage!({ role: 'tool', callId: 'c1', summary: 'Ran: ls' });
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    expect(events.filter(e => e.type === 'delta')).toEqual([
      { type: 'delta', channel: 'reasoning', text: 'let me ' },
      { type: 'delta', channel: 'reasoning', text: 'see ' },
      { type: 'delta', channel: 'content', text: 'Hi ' },
    ]);
    const mid = bridge.connect().at(-1);
    expect(mid).toMatchObject({
      type: 'live',
      live: { phase: 'thinking', reasoning: 'let me see ', content: 'Hi ' },
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
    expect(lives[2]).toMatchObject({ tool: { name: 'bash', output: 'out\n' } });
    expect(events).toContainEqual({ type: 'delta', channel: 'tool', text: 'put\n' });
    expect(lives[3]).toMatchObject({ tool: { name: 'grep', output: 'x\n' } });
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
    expect(lastLive(events).pending).toEqual({ name: 'bash', since: 1000, call: 1 });
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

describe('mode and model switches', () => {
  // A turn that has started but not reached onTurnStart: the line is being prepared, status idle.
  const heldBeforeStart = (session: ReturnType<typeof fakeSession>) => {
    const gate = deferred();
    session.turn = async (text, opts) => {
      await gate.promise;
      opts.onTurnStart?.();
      opts.events?.onMessage?.(user(text));
      opts.onTurnEnd?.();
      return [];
    };
    return gate;
  };

  it('switches the mode between lines, and a repeat of the current mode is a no-op', () => {
    const { controller, bridge, events } = setup();
    expect(bridge.handle({ type: 'mode', mode: 'plan' })).toEqual({ ok: true });
    expect(controller.mode).toBe('plan');
    expect(events.filter(e => e.type === 'message')).toEqual([]);
    events.length = 0;
    expect(bridge.handle({ type: 'mode', mode: 'plan' })).toEqual({ ok: true });
    expect(events).toEqual([]);
  });

  it('refuses a switch while a line is being prepared, runs, waits on a dialog or is queued', async () => {
    const refused = { ok: false, conflict: true };
    const { controller, session, bridge } = setup();
    const gate = heldBeforeStart(session);
    bridge.handle({ type: 'submit', text: 'first' });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', preparing: true });
    expect(bridge.handle({ type: 'mode', mode: 'shell' })).toMatchObject(refused);
    expect(bridge.handle({ type: 'model', name: 'other' })).toMatchObject(refused);
    gate.resolve();
    await vi.waitFor(() => expect(controller.getSnapshot().preparing).toBe(false));

    controller.setStatus('busy');
    expect(bridge.handle({ type: 'mode', mode: 'shell' })).toMatchObject(refused);
    controller.setStatus('idle');

    const asked = controller.openConfirm({
      title: 't',
      subtitle: 's',
      details: [],
      options: ['a'],
    });
    expect(bridge.handle({ type: 'mode', mode: 'shell' })).toMatchObject(refused);
    controller.answerConfirm(0);
    await asked;

    controller.enqueue({ content: 'later', answers: {} });
    expect(bridge.handle({ type: 'mode', mode: 'shell' })).toMatchObject(refused);
    expect(controller.mode).toBe('agent');
    expect(session.setProfile).not.toHaveBeenCalled();
  });

  it('refuses a switch before the session has booted', () => {
    const controller = createController({ mode: 'agent', remember: vi.fn(), historyRoot: root });
    const bridge = createWebBridge(controller);
    expect(bridge.handle({ type: 'mode', mode: 'plan' })).toMatchObject({ ok: false });
    expect(bridge.handle({ type: 'model', name: 'other' })).toMatchObject({ ok: false });
  });

  it('refuses a submit typed in a mode another tab has since left', async () => {
    const { controller, session, bridge } = setup();
    expect(bridge.handle({ type: 'submit', text: 'hi', mode: 'agent' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.getSnapshot().preparing).toBe(false));
    controller.replace([]);
    session.submit.mockClear();
    bridge.handle({ type: 'mode', mode: 'shell' });
    expect(bridge.handle({ type: 'submit', text: 'fix it', mode: 'agent' })).toEqual({
      ok: false,
      error: 'the mode is now shell, not agent',
      conflict: true,
    });
    await flush();
    expect(controller.messages).toEqual([]);
    expect(session.submit).not.toHaveBeenCalled();
  });

  it('picks a listed model, pinned as /model pins it, and closes an open picker', async () => {
    const { controller, session, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: '/model' });
    await flush();
    const [picker] = dialogs(events);
    expect(bridge.handle({ type: 'model', name: 'other' })).toEqual({ ok: true });
    expect(session.setProfile).toHaveBeenCalledWith('other');
    expect(resolved(events)).toEqual([{ id: picker.id, outcome: 'cancelled' }]);
    expect(controller.modelPinned).toBe(true);
    expect(events.filter(e => e.type === 'state').at(-1)).toMatchObject({
      state: { modelPinned: true },
    });
  });

  it('takes only a listed model name', () => {
    const { session, bridge } = setup();
    expect(bridge.handle({ type: 'model', name: 'made-up' })).toEqual({
      ok: false,
      error: 'name is not one of the listed models',
    });
    expect(session.addProfile).not.toHaveBeenCalled();
    expect(session.setProfile).not.toHaveBeenCalled();
  });
});

describe('pastes', () => {
  const big = (tag: string) => `${tag}\n`.repeat(12);
  const marker = (id: number) => `[Pasted text #${id} +12 lines]`;

  it('expands a paste last, so the questions read only the words typed (#448)', async () => {
    const { session, bridge } = setup();
    const log = `error at https://example.com/a\n`.repeat(12);
    bridge.handle({
      type: 'submit',
      text: `why does this fail? ${marker(1)}`,
      pastes: [{ marker: marker(1), text: log }],
    });
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
    expect(session.submit.mock.calls[0][0]).toBe(`why does this fail? ${log}`);
  });

  it('numbers two tabs’ #1 apart, and a recalled marker still expands', async () => {
    const { session, bridge } = setup();
    bridge.handle({
      type: 'submit',
      text: marker(1),
      pastes: [{ marker: marker(1), text: big('a') }],
    });
    bridge.handle({
      type: 'submit',
      text: marker(1),
      pastes: [{ marker: marker(1), text: big('b') }],
    });
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2));
    expect(session.submit.mock.calls.map(c => c[0])).toEqual([big('a'), big('b')]);

    // The second line went through the queue as #2; recalled, it needs no pastes of its own.
    bridge.handle({ type: 'submit', text: `again ${marker(2)}` });
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(3));
    expect(session.submit.mock.calls[2][0]).toBe(`again ${big('b')}`);
  });

  it('records the line with the server’s marker, for recall in every tab', async () => {
    const { controller, bridge, events } = setup();
    bridge.handle({
      type: 'submit',
      text: `x ${marker(4)}`,
      pastes: [{ marker: marker(4), text: big('a') }],
    });
    await flush();
    expect(controller.getSnapshot().history).toEqual([`x ${marker(1)}`]);
    expect(events.filter(e => e.type === 'historyAdd')).toEqual([
      { type: 'historyAdd', seq: expect.any(Number), entry: `x ${marker(1)}` },
    ]);
  });
});

describe('history', () => {
  it('appends a line, sends the whole list when it is cut, and is in every snapshot', async () => {
    const { controller, bridge, events } = setup('agent', { maxLogEvents: 2 });
    bridge.handle({ type: 'submit', text: 'one' });
    bridge.handle({ type: 'submit', text: 'two' });
    await vi.waitFor(() => expect(controller.getSnapshot().history).toEqual(['one', 'two']));
    expect(
      events.filter(e => e.type === 'historyAdd').map(e => (e as { entry: string }).entry),
    ).toEqual(['one', 'two']);
    const snapshot = bridge.connect(1);
    expect(snapshot.find(e => e.type === 'history')).toMatchObject({ entries: ['one', 'two'] });
    expect(snapshot.find(e => e.type === 'catalog')).toMatchObject({
      catalog: { models: expect.arrayContaining([expect.objectContaining({ name: 'default' })]) },
    });
  });
});

describe('completions', () => {
  it('answers with the controller’s list, and null before boot', () => {
    const { session, bridge } = setup();
    session.bundle.fileIndex = ['src/app.ts', 'README.md'] as never;
    expect(bridge.handle({ type: 'complete', text: 'see @app' })).toEqual({
      ok: true,
      reply: {
        kind: 'file',
        partial: '@app',
        items: [{ value: '@src/app.ts', display: 'src/app.ts' }],
      },
    });
    expect(bridge.handle({ type: 'complete', text: '/mod' })).toMatchObject({
      ok: true,
      reply: { kind: 'command', items: [expect.objectContaining({ value: '/model' })] },
    });
    expect(bridge.handle({ type: 'complete', text: 'plain words' })).toEqual({
      ok: true,
      reply: null,
    });

    const unbooted = createWebBridge(
      createController({ mode: 'agent', remember: vi.fn(), historyRoot: root }),
    );
    expect(unbooted.handle({ type: 'complete', text: '/mod' })).toEqual({ ok: true, reply: null });
  });
});

describe('stage', () => {
  afterEach(() => {
    linkFetch.gate = null;
  });

  it('shows what a submit is waiting on, and clears it when the wait ends', async () => {
    const gate = deferred();
    linkFetch.gate = gate.promise;
    const { session, bridge, events } = setup();
    bridge.handle({ type: 'submit', text: 'https://example.com/docs' });
    await vi.waitFor(() =>
      expect(events.filter(e => e.type === 'state').at(-1)).toMatchObject({
        state: { stage: 'Fetching 1 pasted link' },
      }),
    );
    gate.resolve();
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
    expect(events.filter(e => e.type === 'state').at(-1)).toMatchObject({ state: { stage: null } });
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

describe('scrub (#990)', () => {
  const HOME = homedir();
  afterEach(() => clearIdentity());
  const anon = () => setIdentity({ names: ['Mona Lisa'], emails: ['octocat@example.com'] });
  const sent = (events: ServerEvent[]) => JSON.stringify(events);

  it('sends home paths as ~/… and keeps the input history raw', async () => {
    const { controller, bridge, events } = setup();
    controller.append(note(`wrote ${HOME}/notes.md`));
    bridge.handle({ type: 'submit', text: `look at ${HOME}/notes.md` });
    await vi.waitFor(() => expect(controller.getSnapshot().history).toHaveLength(1));
    expect(sent(events.filter(e => e.type !== 'historyAdd'))).not.toContain(HOME);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'wrote ~/notes.md' }),
      }),
    );
    // Recalled into the box and sent again, so the real text.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'historyAdd', entry: `look at ${HOME}/notes.md` }),
    );
    expect(controller.messages.some(m => 'content' in m && m.content.includes(HOME))).toBe(true);
  });

  it('re-sends everything under /anon, to open tabs and to one that reconnects', () => {
    const { controller, bridge, events } = setup();
    controller.append(note('by Mona Lisa'));
    void controller.requestApproval({ tool: 'bash', subject: 'Mona Lisa', preview: 'ls' });
    const before = bridge.connect().at(0)!;
    const oldSeq = 'seq' in before ? before.seq : 0;
    expect(sent(events)).toContain('Mona Lisa');

    events.length = 0;
    anon();
    controller.append(note('anon on'));
    expect(types(events).slice(0, 3)).toEqual(['reset', 'state', 'dialog']);
    expect(types(events)).toContain('live');
    expect(sent(events)).not.toContain('Mona Lisa');
    // The log no longer holds what was sent before the switch.
    const replay = bridge.connect(oldSeq);
    expect(types(replay)).toContain('reset');
    expect(sent(replay)).not.toContain('Mona Lisa');
    expect(sent(bridge.connect())).not.toContain('Mona Lisa');
  });

  it('scrubs a reply’s error', async () => {
    const { controller, bridge } = setup();
    anon();
    vi.spyOn(controller, 'sessionList').mockRejectedValue(
      new Error(`ENOENT ${HOME}/Mona Lisa/history`),
    );
    expect(await bridge.handle({ type: 'sessions', scope: 'project' })).toEqual({
      ok: false,
      error: 'ENOENT ~/<user>/history',
    });
  });

  it('filters sessions on the titles a tab draws, not the raw ones', async () => {
    const { controller, bridge } = setup();
    anon();
    vi.spyOn(controller, 'sessionList').mockResolvedValue([
      { path: '/h/a.jsonl', title: 'ask Mona Lisa', savedAt: '2026-01-01', messageCount: 2 },
    ]);
    const reply = (filter: string) => bridge.handle({ type: 'sessions', scope: 'project', filter });
    expect(await reply('mona')).toMatchObject({ reply: { entries: [], total: 0 } });
    expect(await reply('<user>')).toMatchObject({
      reply: { entries: [{ id: 'a.jsonl', title: 'ask <user>' }], total: 1 },
    });
  });

  it('streams a path without ever drawing part of it', async () => {
    const { session, bridge, events } = setup();
    const gate = deferred();
    session.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      const ev = opts.events!;
      ev.onPhase!('thinking');
      ev.onContentDelta!(`open ${HOME.slice(0, 4)}`);
      ev.onContentDelta!(`${HOME.slice(4)}/notes.md now`);
      await gate.promise;
      opts.onTurnEnd?.();
      return [];
    };
    bridge.handle({ type: 'submit', text: 'go' });
    await flush();
    const deltas = events.flatMap(e => (e.type === 'delta' ? [e] : []));
    expect(deltas.map(d => d.text).join('')).toBe('open ~/notes.md ');
    expect(sent(events)).not.toContain(HOME.slice(0, 4) + HOME.slice(4, 6));
    expect(lastLive(bridge.connect()).content).toBe('open ~/notes.md ');
    gate.resolve();
  });
});
