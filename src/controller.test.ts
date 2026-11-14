import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createController } from './controller.js';
import { listSessions, loadSession, projectHistoryDir } from './store/sessions.js';
import { TRANSCRIPT_VERSION, type TranscriptMeta } from './store/transcript.js';
import type { QueuedMessage } from './agent/busyqueue.js';
import type { LastState } from './laststate.js';
import type { Session } from './session.js';
import type { Config, Message, Mode, Profile } from './types.js';

const user = (content: string): Message => ({ role: 'user', content });
const note = (content: string): Message => ({ role: 'system', content });

type Policy = Partial<Config>;

const profileOf = (model: string): Profile => ({
  model,
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
});

// The parts of a session the controller reads: its config and active profile, and the three
// calls it makes. `setProfile` reports one probe notice, as the real one does for a new window.
function fakeSession(config: Policy) {
  const cfg = {
    autoApprove: 'off',
    models: ['local'],
    profiles: { default: profileOf('local') },
    ...config,
  } as Config;
  const session = {
    profile: 'default',
    bundle: { cwd: '/repo/app' },
    getSnapshot: () => ({ config: cfg }),
    switchSide: vi.fn(),
    loadHistory: vi.fn(),
    // Like the real one: a relearning reset drops back to the default profile.
    reset: vi.fn((opts: { relearn?: boolean } = {}) => {
      if (opts.relearn) session.profile = 'default';
    }),
    addProfile: vi.fn((name: string, profile: Profile) => {
      cfg.profiles[name] = profile;
    }),
    setProfile: vi.fn(async (name: string): Promise<Message[]> => {
      session.profile = name;
      return [{ role: 'system', content: `window probed for ${name}` }];
    }),
  };
  return session;
}

// `off` unless a test says otherwise, so every approval request opens its dialog. A null policy
// is a controller whose session has not booted.
const metaFor = (agentSide: Message[], cwd: string, midTurn: boolean): TranscriptMeta => ({
  version: TRANSCRIPT_VERSION,
  savedAt: new Date().toISOString(),
  model: 'local',
  baseURL: 'http://127.0.0.1:1/v1',
  cwd,
  messageCount: agentSide.length,
  mode: 'agent',
  ...(midTurn ? { midTurn: true as const } : {}),
});

function controllerIn(
  mode: Mode,
  policy: Policy | null = {},
  own = 'default',
  historyRoot?: string,
) {
  const remember = vi.fn<(state: LastState) => void>();
  const transcriptMeta = vi.fn(metaFor);
  const controller = createController({ mode, remember, transcriptMeta, historyRoot });
  const session = policy ? fakeSession(policy) : null;
  if (session) controller.attachSession(session as unknown as Session, own);
  return {
    controller,
    session,
    switchSide: session?.switchSide ?? vi.fn(),
    remember,
    transcriptMeta,
  };
}

describe('createController', () => {
  it('starts with an empty scrollback in the given mode', () => {
    const { controller } = controllerIn('plan');
    expect(controller.getSnapshot()).toEqual({
      messages: [],
      mode: 'plan',
      status: 'loading',
      queue: [],
      replaying: false,
      approval: null,
      question: null,
      confirm: null,
      approvals: { approved: 0, declined: 0 },
      sessionAutoApprove: null,
      sessionUnattended: null,
    });
    expect(controller.messages).toEqual([]);
    expect(controller.mode).toBe('plan');
  });

  it('hands back the same snapshot until something changes', () => {
    const { controller } = controllerIn('agent');
    const before = controller.getSnapshot();
    controller.append();
    controller.setMode('agent');
    expect(controller.getSnapshot()).toBe(before);
    controller.append(user('hi'));
    expect(controller.getSnapshot()).not.toBe(before);
  });

  it('tells subscribers about each change, and stops when they unsubscribe', () => {
    const { controller } = controllerIn('agent');
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.append(user('a'));
    controller.setMode('plan');
    controller.replace([]);
    expect(listener).toHaveBeenCalledTimes(3);
    controller.append();
    controller.setMode('plan');
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    controller.append(user('b'));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('appends in order and keeps each message object as given', () => {
    const { controller } = controllerIn('agent');
    const [a, b, c] = [user('a'), note('b'), user('c')];
    controller.append(a);
    controller.append(b, c);
    expect(controller.messages).toEqual([a, b, c]);
    expect(controller.messages[1]).toBe(b);
  });

  it('replaces the scrollback on screen', () => {
    const { controller } = controllerIn('agent');
    controller.append(user('old'));
    const fresh = [note('New session')];
    controller.replace(fresh);
    expect(controller.messages).toBe(fresh);
  });
});

describe('controller.transition', () => {
  it('changes mode within a side without touching the scrollback or the session', () => {
    const { controller, switchSide } = controllerIn('agent');
    controller.append(user('task'));
    const before = controller.messages;
    controller.transition('plan');
    expect(controller.mode).toBe('plan');
    expect(controller.messages).toBe(before);
    expect(switchSide).not.toHaveBeenCalled();
  });

  it('appends the trailing lines on a switch within a side', () => {
    const { controller } = controllerIn('agent');
    const task = user('task');
    const banner = note('Plan mode');
    controller.append(task);
    controller.transition('plan', [banner]);
    expect(controller.messages).toEqual([task, banner]);
  });

  it('puts the agent side away on the way into chat, and brings it back on the way out', () => {
    const { controller, switchSide } = controllerIn('agent');
    const task = user('agent task');
    controller.append(task);

    const chatBanner = note('Chat mode');
    controller.transition('chat', [chatBanner]);
    expect(controller.mode).toBe('chat');
    expect(controller.messages).toEqual([chatBanner]);
    expect(switchSide).toHaveBeenLastCalledWith('chat');

    const question = user('what is a monad');
    controller.append(question);
    const agentBanner = note('Agent mode');
    controller.transition('agent', [agentBanner]);
    expect(controller.messages).toEqual([task, agentBanner]);
    expect(switchSide).toHaveBeenLastCalledWith('agent');

    controller.transition('chat');
    expect(controller.messages).toEqual([chatBanner, question]);
  });

  it('treats every mode but chat as the agent side', () => {
    const { controller, switchSide } = controllerIn('shell');
    controller.append(user('ls'));
    for (const mode of ['minimal', 'vibe', 'grind', 'plan', 'agent'] as const) {
      controller.transition(mode);
    }
    expect(controller.messages).toHaveLength(1);
    expect(switchSide).not.toHaveBeenCalled();
  });
});

describe('controller sides and stash', () => {
  it('reports both sides whichever one is on screen', () => {
    const { controller } = controllerIn('agent');
    const task = user('agent task');
    controller.append(task);
    expect(controller.sides()).toEqual({ agent: [task], chat: [] });

    controller.transition('chat');
    const question = user('chat question');
    controller.append(question);
    expect(controller.sides()).toEqual({ agent: [task], chat: [question] });
  });

  it('setMode moves the mode alone: nothing is put away and the session is not told', () => {
    const { controller, switchSide } = controllerIn('agent');
    controller.append(user('still here'));
    controller.setMode('chat');
    expect(controller.mode).toBe('chat');
    expect(controller.messages).toHaveLength(1);
    expect(switchSide).not.toHaveBeenCalled();
  });
});

describe('controller status and queue', () => {
  const queued = (content: string): QueuedMessage => ({ content, answers: {} });
  const open = { resuming: false };

  it('reports the status and notifies only when it changes', () => {
    const { controller } = controllerIn('agent');
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setStatus('idle');
    controller.setStatus('idle');
    expect(controller.status).toBe('idle');
    expect(controller.getSnapshot().status).toBe('idle');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('holds a prompt and prints its receipt in one change', () => {
    const { controller } = controllerIn('agent');
    const listener = vi.fn();
    controller.subscribe(listener);
    const first = queued('fix the tests');
    controller.enqueue(first);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().queue).toEqual([first]);
    expect(controller.messages).toEqual([
      { role: 'system', content: '[Queued] fix the tests', tone: 'info' },
    ]);
  });

  it('hands nothing back while a turn runs, the session boots, a dialog is up or a resume loads', () => {
    const { controller } = controllerIn('agent');
    controller.enqueue(queued('later'));
    expect(controller.takeQueued(open)).toBeNull();
    controller.setStatus('busy');
    expect(controller.takeQueued(open)).toBeNull();
    controller.setStatus('idle');
    expect(controller.takeQueued({ resuming: true })).toBeNull();
    expect(controller.getSnapshot().queue).toHaveLength(1);
  });

  it('holds the queue under an approval or a confirm, and releases it once answered', () => {
    const { controller } = controllerIn('agent');
    controller.enqueue(queued('later'));
    controller.setStatus('idle');

    void controller.requestApproval({ tool: 'bash', subject: 'npm test', preview: 'npm test' });
    expect(controller.takeQueued(open)).toBeNull();
    controller.answerApproval(true);

    void controller.openConfirm({
      title: 'Skill',
      subtitle: '/issue',
      details: [],
      options: ['Send as typed', 'Apply'],
    });
    expect(controller.takeQueued(open)).toBeNull();
    controller.answerConfirm('abort');

    expect(controller.takeQueued(open)).toMatchObject({ content: 'later' });
  });

  it('hands back the oldest prompt, then nothing more until that replay is done (#958)', () => {
    const { controller } = controllerIn('agent');
    const [a, b] = [queued('a'), queued('b')];
    controller.enqueue(a);
    controller.enqueue(b);
    controller.setStatus('idle');

    expect(controller.takeQueued(open)).toBe(a);
    expect(controller.getSnapshot()).toMatchObject({ queue: [b], replaying: true });
    expect(controller.takeQueued(open)).toBeNull();

    controller.replayDone();
    expect(controller.getSnapshot().replaying).toBe(false);
    expect(controller.takeQueued(open)).toBe(b);
    expect(controller.getSnapshot().queue).toEqual([]);
  });

  it('has nothing to hand back from an empty queue, and does not start a replay', () => {
    const { controller } = controllerIn('agent');
    controller.setStatus('idle');
    const before = controller.getSnapshot();
    expect(controller.takeQueued(open)).toBeNull();
    controller.replayDone();
    expect(controller.getSnapshot()).toBe(before);
  });
});

describe('controller dialogs', () => {
  const request = { tool: 'bash', subject: 'npm test', preview: 'npm test' };
  const question = { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] };
  const spec = {
    title: 'Skill',
    subtitle: '/issue',
    details: [],
    options: ['Send as typed', 'Apply /issue'],
  };

  it('shows an approval until it is answered, and resolves with the answer', async () => {
    const { controller } = controllerIn('agent');
    const answer = controller.requestApproval(request);
    expect(controller.approval).toBe(request);
    expect(controller.getSnapshot().approval).toBe(request);
    controller.answerApproval({ feedback: 'not that file' });
    expect(controller.approval).toBeNull();
    await expect(answer).resolves.toEqual({ feedback: 'not that file' });
  });

  it('resolves a question with its answer, or with null when it is dropped', async () => {
    const { controller } = controllerIn('agent');
    const first = controller.openQuestion(question);
    expect(controller.question).toBe(question);
    controller.answerQuestion({ text: 'B', index: 1 });
    await expect(first).resolves.toEqual({ text: 'B', index: 1 });

    const second = controller.openQuestion(question);
    controller.answerQuestion(null);
    expect(controller.question).toBeNull();
    await expect(second).resolves.toBeNull();
  });

  it('resolves a confirm with the chosen row, or abort', async () => {
    const { controller } = controllerIn('agent');
    const first = controller.openConfirm(spec);
    expect(controller.confirm).toBe(spec);
    controller.answerConfirm(1);
    await expect(first).resolves.toBe(1);

    const second = controller.openConfirm(spec);
    controller.answerConfirm('abort');
    await expect(second).resolves.toBe('abort');
    expect(controller.confirm).toBeNull();
  });

  it('closes the dialog before the answer reaches whoever asked', async () => {
    const { controller } = controllerIn('agent');
    let openWhenResolved: unknown = 'unset';
    const asked = controller.requestApproval(request).then(() => {
      openWhenResolved = controller.approval;
    });
    controller.answerApproval(true);
    await asked;
    expect(openWhenResolved).toBeNull();
  });

  it('ignores an answer when nothing is open', () => {
    const { controller } = controllerIn('agent');
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.answerApproval(true);
    controller.answerQuestion(null);
    controller.answerConfirm(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the three kinds apart: answering one leaves the others open', () => {
    const { controller } = controllerIn('agent');
    void controller.requestApproval(request);
    void controller.openQuestion(question);
    void controller.openConfirm(spec);
    controller.answerQuestion(null);
    expect(controller.approval).toBe(request);
    expect(controller.confirm).toBe(spec);
  });
});

describe('controller approval gate', () => {
  const ordinary = { tool: 'edit', subject: 'src/a.ts', preview: '+ line' };
  const flagged = {
    tool: 'bash',
    subject: 'rm -rf build',
    preview: 'rm -rf build',
    warnings: ['Deletes files'],
  };

  it('asks about everything when auto-approve is off', async () => {
    const { controller } = controllerIn('agent', { autoApprove: 'off' });
    expect(controller.autoApprove).toBe('off');
    const answer = controller.requestApproval(ordinary);
    expect(controller.approval).toBe(ordinary);
    controller.answerApproval(true);
    await expect(answer).resolves.toBe(true);
    expect(controller.getSnapshot().approvals).toEqual({ approved: 1, declined: 0 });
  });

  it('runs an ordinary action unasked under safe, and still asks about a flagged one', async () => {
    const { controller } = controllerIn('agent', { autoApprove: 'safe' });
    await expect(controller.requestApproval(ordinary)).resolves.toBe(true);
    expect(controller.approval).toBeNull();
    expect(controller.getSnapshot().approvals).toEqual({ approved: 1, declined: 0 });

    void controller.requestApproval(flagged);
    expect(controller.approval).toBe(flagged);
  });

  it('counts a decline, with or without a reason', () => {
    const { controller } = controllerIn('agent');
    void controller.requestApproval(ordinary);
    controller.answerApproval(false);
    void controller.requestApproval(ordinary);
    controller.answerApproval({ feedback: 'wrong file' });
    expect(controller.getSnapshot().approvals).toEqual({ approved: 0, declined: 2 });
  });

  it('"Always (this session)" approves this one and stops asking about ordinary ones', async () => {
    const { controller } = controllerIn('agent', { autoApprove: 'off' });
    const first = controller.requestApproval(ordinary);
    controller.answerApproval(true, { always: true });
    await expect(first).resolves.toBe(true);
    expect(controller.getSnapshot().sessionAutoApprove).toBe(true);
    expect(controller.autoApprove).toBe('safe');

    await expect(controller.requestApproval(ordinary)).resolves.toBe(true);
    expect(controller.approval).toBeNull();
    expect(controller.getSnapshot().approvals).toEqual({ approved: 2, declined: 0 });

    void controller.requestApproval(flagged);
    expect(controller.approval).toBe(flagged);
  });

  it('lets the session toggle turn a default safe off, but not an env-forced one', () => {
    const byDefault = controllerIn('agent', { autoApprove: 'safe' }).controller;
    byDefault.setSessionAutoApprove(false);
    expect(byDefault.autoApprove).toBe('off');

    const forced = controllerIn('agent', {
      autoApprove: 'safe',
      autoApproveExplicit: true,
    }).controller;
    forced.setSessionAutoApprove(false);
    expect(forced.autoApprove).toBe('safe');
  });

  it('asks about everything before the session has a config', () => {
    const { controller } = controllerIn('agent', null);
    expect(controller.autoApprove).toBe('off');
    expect(controller.unattended).toBe(false);
  });

  it('declines what would have asked when unattended, and keeps the list for the roll-up', async () => {
    const { controller } = controllerIn('agent', { autoApprove: 'safe', unattended: true });
    expect(controller.unattended).toBe(true);
    await expect(controller.requestApproval(ordinary)).resolves.toBe(true);
    await expect(controller.requestApproval(flagged)).resolves.toBe(false);
    expect(controller.approval).toBeNull();
    expect(controller.getSnapshot().approvals).toEqual({ approved: 1, declined: 1 });
    expect(controller.takeUnattendedDeclines()).toEqual([flagged]);
    expect(controller.takeUnattendedDeclines()).toEqual([]);
  });

  it('lets /unattended override the launch state in either direction', () => {
    const launchedOn = controllerIn('agent', { autoApprove: 'off', unattended: true }).controller;
    launchedOn.setSessionUnattended(false);
    expect(launchedOn.unattended).toBe(false);
    void launchedOn.requestApproval(ordinary);
    expect(launchedOn.approval).toBe(ordinary);

    const launchedOff = controllerIn('agent', { autoApprove: 'off' }).controller;
    launchedOff.setSessionUnattended(true);
    expect(launchedOff.unattended).toBe(true);
  });
});

describe('controller modes and the saved state', () => {
  it('remembers a work mode the user switched to, by either route', () => {
    const { controller, remember } = controllerIn('agent');
    controller.transition('plan');
    controller.setMode('grind');
    expect(remember.mock.calls).toEqual([[{ mode: 'plan' }], [{ mode: 'grind' }]]);
  });

  it('leaves the last work mode saved across chat and shell, which no session opens in', () => {
    const { controller, remember } = controllerIn('plan');
    controller.transition('chat');
    controller.transition('shell');
    expect(remember).not.toHaveBeenCalled();
  });

  it('saves nothing for the mode it starts in, or for a switch to the mode it is in', () => {
    const { controller, remember } = controllerIn('plan');
    controller.setMode('plan');
    controller.transition('plan');
    expect(remember).not.toHaveBeenCalled();
  });
});

describe('controller model switching', () => {
  const profiles = {
    default: profileOf('local'),
    kimi: profileOf('kimi-k3'),
    go: profileOf('deepseek'),
  };

  it('has no targets and ignores a pick before the session has booted', () => {
    const { controller, remember } = controllerIn('agent', null);
    expect(controller.session).toBeNull();
    expect(controller.modelTargets()).toEqual([]);
    controller.pickModel('kimi');
    expect(controller.messages).toEqual([]);
    expect(remember).not.toHaveBeenCalled();
  });

  it('switches to a picked profile, says so under the echo, and remembers it', async () => {
    const { controller, session, remember } = controllerIn('agent', { profiles });
    const echo: Message = { role: 'user', content: '/model kimi', meta: true };
    controller.pickModel(' Kimi ', echo);
    expect(session?.setProfile).toHaveBeenCalledWith('kimi');
    expect(controller.messages).toEqual([
      echo,
      { role: 'system', content: "Switched to profile 'kimi' (kimi-k3)" },
    ]);
    expect(remember).toHaveBeenCalledWith({ profile: 'kimi' });
    await Promise.resolve();
    expect(controller.messages.at(-1)).toEqual({
      role: 'system',
      content: 'window probed for kimi',
    });
  });

  it("maps one of the config's models to the profile that serves it", () => {
    const { controller, session } = controllerIn('agent', { profiles, models: ['local'] });
    controller.pickModel('LOCAL');
    expect(session?.setProfile).toHaveBeenCalledWith('default');
    expect(controller.messages).toEqual([
      { role: 'system', content: "Switched to profile 'default' (local)" },
    ]);
  });

  it("tries a name the config lacks on the active profile's server, as typed", () => {
    const { controller, session } = controllerIn('agent', { profiles });
    controller.pickModel('Qwen3-Next');
    expect(session?.addProfile).toHaveBeenCalledWith('qwen3-next', {
      ...profileOf('Qwen3-Next'),
      contextWindow: undefined,
      adhoc: true,
    });
    expect(session?.setProfile).toHaveBeenCalledWith('qwen3-next');
    expect(controller.messages[0]).toEqual({
      role: 'system',
      content:
        "Switched to model 'Qwen3-Next' — not in your config; using it anyway on http://127.0.0.1:1/v1",
    });
  });

  it("brings a mode's own model with the mode, and comes back to the session's on the way out", () => {
    const { controller, session, remember } = controllerIn(
      'agent',
      { profiles, modeProfiles: { plan: 'kimi' } },
      'go',
    );
    controller.transition('plan', [note('Plan mode')]);
    expect(session?.profile).toBe('kimi');
    expect(controller.messages).toEqual([
      note('Plan mode'),
      note("Switched to profile 'kimi' (kimi-k3)"),
    ]);

    controller.transition('agent');
    expect(session?.profile).toBe('go');
    // A mode's model is re-derived every launch, so only the mode is remembered.
    expect(remember.mock.calls).toEqual([[{ mode: 'plan' }], [{ mode: 'agent' }]]);
  });

  it('leaves the model alone in shell, and where the mode already runs on it', () => {
    const { controller, session } = controllerIn('agent', { profiles });
    controller.transition('shell');
    controller.transition('grind');
    expect(session?.setProfile).not.toHaveBeenCalled();
  });

  it('keeps a picked model through mode switches until it is unpinned', () => {
    const { controller, session } = controllerIn('agent', {
      profiles,
      modeProfiles: { plan: 'kimi' },
    });
    controller.pickModel('go');
    controller.transition('plan');
    expect(session?.profile).toBe('go');
  });

  it('lists the picker targets with the active one marked', () => {
    const { controller } = controllerIn('agent', { profiles });
    controller.pickModel('kimi');
    const active = controller.modelTargets().filter(t => t.active);
    expect(active.map(t => t.name)).toEqual(['kimi']);
  });
});

describe('controller.newConversation', () => {
  const profiles = {
    default: profileOf('local'),
    kimi: profileOf('kimi-k3'),
    go: profileOf('deepseek'),
  };
  const echo: Message = { role: 'user', content: '/new', meta: true };
  const receipt = note('New session — conversation, tokens, and mode reset.');

  it('seeds the scrollback with the echo and a receipt, and drops both sides', () => {
    const { controller } = controllerIn('agent');
    controller.append(user('agent task'));
    controller.transition('chat');
    controller.append(user('chat question'));

    controller.newConversation(echo);
    expect(controller.messages).toEqual([echo, receipt]);
    expect(controller.mode).toBe('agent');
    expect(controller.sides()).toEqual({ agent: [echo, receipt], chat: [] });
  });

  it('resets the session with what it learned, and puts it on the agent side', () => {
    const { controller, session } = controllerIn('chat');
    controller.newConversation(echo);
    expect(session?.reset).toHaveBeenCalledWith({ relearn: true });
    expect(session?.switchSide).toHaveBeenLastCalledWith('agent');
  });

  it('clears the counters and the auto-approve toggle, and leaves unattended as it was', () => {
    const { controller } = controllerIn('agent');
    void controller.requestApproval({ tool: 'edit', subject: 'a.ts', preview: '+ x' });
    controller.answerApproval(true, { always: true });
    controller.setSessionUnattended(true);

    controller.newConversation(echo);
    expect(controller.getSnapshot()).toMatchObject({
      approvals: { approved: 0, declined: 0 },
      sessionAutoApprove: null,
      sessionUnattended: true,
    });
  });

  it('moves the start time forward', async () => {
    const { controller } = controllerIn('agent');
    const before = controller.startedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.newConversation(echo);
    expect(controller.startedAt).toBeGreaterThan(before);
  });

  it('forgets a picked model, so the mode map applies again', () => {
    const { controller, session } = controllerIn('agent', {
      profiles,
      modeProfiles: { plan: 'kimi' },
    });
    controller.pickModel('go');
    controller.newConversation(echo);
    expect(session?.profile).toBe('default');

    controller.transition('plan');
    expect(session?.profile).toBe('kimi');
  });

  it('comes back to the default profile, not the one the session opened on', () => {
    const { controller, session } = controllerIn('plan', { profiles }, 'go');
    controller.newConversation(echo);
    expect(session?.profile).toBe('default');
    expect(session?.setProfile).not.toHaveBeenCalled();
    // One line only: no switch to the opening profile and back.
    expect(controller.messages).toEqual([echo, receipt]);
  });

  it("lands on agent mode's own model when it has one, under the receipt", () => {
    const { controller, session } = controllerIn('plan', {
      profiles,
      modeProfiles: { agent: 'kimi' },
    });
    controller.newConversation(echo);
    expect(session?.profile).toBe('kimi');
    expect(controller.messages).toEqual([
      echo,
      receipt,
      note("Switched to profile 'kimi' (kimi-k3)"),
    ]);
  });
});

describe('controller.loadConversation', () => {
  const saved = {
    agent: [user('fix the parser'), { role: 'assistant', content: 'fixed' } as Message],
    chat: [user('what is a monad')],
  };
  const from = { title: 'fix the parser', path: '/history/a.jsonl' };

  it('hands back the side on screen and a receipt, and keeps the other side off screen', () => {
    const { controller, session } = controllerIn('agent');
    controller.append(user('old conversation'));
    const rows = controller.loadConversation(saved, from);
    expect(rows).toEqual([
      ...saved.agent,
      note(
        'Resumed "fix the parser" — 2 agent messages (+ 1 on the chat side) from /history/a.jsonl',
      ),
    ]);
    expect(controller.mode).toBe('agent');
    expect(controller.messages).toEqual([]);
    expect(session?.reset).toHaveBeenCalledWith({ relearn: false });

    controller.replace(rows);
    expect(controller.sides().chat).toBe(saved.chat);
    controller.transition('chat');
    expect(controller.messages).toEqual(saved.chat);
  });

  it('gives the session both model histories, the side on screen first', () => {
    const { controller, session } = controllerIn('chat');
    controller.loadConversation(saved, from);
    const [active, other] = session!.loadHistory.mock.calls[0];
    expect(active).toEqual([user('what is a monad')]);
    expect(other).toHaveLength(2);
  });

  it('opens a chat-only session on the chat side', () => {
    const { controller, session } = controllerIn('plan');
    const rows = controller.loadConversation({ agent: [], chat: saved.chat }, from);
    expect(controller.mode).toBe('chat');
    expect(session?.switchSide).toHaveBeenLastCalledWith('chat');
    expect(rows.at(-1)).toEqual(
      note(
        'Resumed "fix the parser" — 1 chat messages, switched to chat mode, from /history/a.jsonl',
      ),
    );
  });

  it('opens an agent-only session in agent mode when resumed from chat', () => {
    const { controller, session } = controllerIn('chat');
    controller.loadConversation({ agent: saved.agent, chat: [] }, from);
    expect(controller.mode).toBe('agent');
    expect(session?.switchSide).toHaveBeenLastCalledWith('agent');
  });

  it('stays in the current mode for a session with both sides', () => {
    const { controller, session } = controllerIn('plan');
    controller.loadConversation(saved, from);
    expect(controller.mode).toBe('plan');
    expect(session?.switchSide).not.toHaveBeenCalled();
  });

  it('calls an untitled session untitled', () => {
    const { controller } = controllerIn('agent');
    const rows = controller.loadConversation(saved, { path: '/history/b.jsonl' });
    expect(rows.at(-1)).toMatchObject({ content: expect.stringContaining('Resumed "untitled"') });
  });

  it('puts the model a mode change brought under the receipt, not in the old scrollback', () => {
    const profiles = { default: profileOf('local'), kimi: profileOf('kimi-k3') };
    const { controller } = controllerIn('chat', { profiles, modeProfiles: { agent: 'kimi' } });
    controller.append(user('old chat'));
    const rows = controller.loadConversation({ agent: saved.agent, chat: [] }, from);
    expect(rows.slice(-2)).toEqual([
      note(
        'Resumed "fix the parser" — 2 agent messages, switched to agent mode, from /history/a.jsonl',
      ),
      note("Switched to profile 'kimi' (kimi-k3)"),
    ]);
  });
});

describe('controller auto-save', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reika-controller-save-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const saving = (mode: Mode = 'agent') => controllerIn(mode, { autosave: true }, 'default', root);
  const projectDir = (): string => projectHistoryDir('/repo/app', root);
  const reply: Message = { role: 'assistant', content: 'done' };
  // A change schedules its save in a microtask; this lets that run and the write land.
  const settled = async (controller: { saveNow(): Promise<void> }): Promise<void> => {
    await Promise.resolve();
    await controller.saveNow();
  };

  it('writes nothing when the config does not ask for it', async () => {
    const { controller } = controllerIn('agent', {}, 'default', root);
    controller.setStatus('idle');
    controller.append(user('fix the parser'));
    await settled(controller);
    expect(controller.sessionPath).toBeNull();
    expect(await listSessions(projectDir())).toEqual([]);
  });

  it('writes nothing for launch notices alone', async () => {
    const { controller } = saving();
    controller.setStatus('idle');
    controller.append(note('No network — search is off'));
    await settled(controller);
    expect(controller.sessionPath).toBeNull();
  });

  it("saves from the first real prompt, into the project's directory", async () => {
    const { controller, transcriptMeta } = saving();
    controller.setStatus('idle');
    controller.append(user('fix the parser'));
    await settled(controller);

    expect(dirname(controller.sessionPath!)).toBe(projectDir());
    expect((await loadSession(controller.sessionPath!)).agent).toEqual([user('fix the parser')]);
    expect(transcriptMeta).toHaveBeenLastCalledWith([user('fix the parser')], '/repo/app', false);
  });

  it('rewrites one file as the conversation grows, with both sides in it', async () => {
    const { controller } = saving();
    controller.setStatus('idle');
    controller.append(user('fix the parser'), reply);
    await settled(controller);
    const path = controller.sessionPath;

    controller.transition('chat');
    controller.append(user('what is a monad'));
    await settled(controller);
    expect(controller.sessionPath).toBe(path);
    expect(await listSessions(projectDir())).toHaveLength(1);
    expect(await loadSession(path!)).toEqual({
      agent: [user('fix the parser'), reply],
      chat: [user('what is a monad')],
    });
  });

  it('makes one save decision for a tick with several changes', async () => {
    const { controller, transcriptMeta } = saving();
    controller.setStatus('idle');
    controller.append(user('a'));
    controller.append(reply);
    controller.append(note('receipt'));
    await Promise.resolve();
    expect(transcriptMeta).toHaveBeenCalledTimes(1);
    await controller.saveNow();
  });

  it('saves at once on the first prompt of a turn, then at most once per interval while it runs', async () => {
    vi.useFakeTimers();
    const { controller, transcriptMeta } = saving();
    controller.setStatus('busy');
    controller.append(user('long task'));
    await Promise.resolve();
    expect(transcriptMeta).toHaveBeenCalledTimes(1);
    expect(transcriptMeta).toHaveBeenLastCalledWith([user('long task')], '/repo/app', true);

    controller.append(reply);
    await Promise.resolve();
    controller.append(reply);
    await Promise.resolve();
    expect(transcriptMeta).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(transcriptMeta).toHaveBeenCalledTimes(2);

    controller.setStatus('idle');
    await Promise.resolve();
    expect(transcriptMeta).toHaveBeenCalledTimes(3);
    expect(transcriptMeta).toHaveBeenLastCalledWith(expect.any(Array), '/repo/app', false);
    vi.useRealTimers();
    await controller.saveNow();
  });

  it('starts a new file after a new conversation', async () => {
    const { controller } = saving();
    controller.setStatus('idle');
    controller.append(user('first'));
    await settled(controller);
    const first = controller.sessionPath;

    controller.newConversation({ role: 'user', content: '/new', meta: true });
    await settled(controller);
    expect(controller.sessionPath).toBeNull();

    controller.append(user('second'));
    await settled(controller);
    expect(controller.sessionPath).not.toBe(first);
    expect(await listSessions(projectDir())).toHaveLength(2);
  });

  it('continues a resumed project session in its own file, and only once it grows', async () => {
    const { controller, transcriptMeta } = saving();
    controller.setStatus('idle');
    const path = join(projectDir(), 'earlier.jsonl');
    const sides = { agent: [user('fix the parser'), reply], chat: [] };
    controller.replace(controller.loadConversation(sides, { path }));
    await settled(controller);
    expect(controller.sessionPath).toBe(path);
    expect(transcriptMeta).not.toHaveBeenCalled();

    controller.append(user('and the lexer'));
    await settled(controller);
    // The two saved messages, the "Resumed" receipt, and the new prompt.
    const agent = (await loadSession(path)).agent;
    expect(agent).toHaveLength(4);
    expect(agent.at(-1)).toEqual(user('and the lexer'));
    expect(await listSessions(projectDir())).toHaveLength(1);
  });

  it('leaves a resumed root save untouched and continues in a project file', async () => {
    const { controller } = saving();
    controller.setStatus('idle');
    const rootSave = join(root, 'manual.jsonl');
    await writeFile(rootSave, 'left as it was');
    const sides = { agent: [user('fix the parser'), reply], chat: [] };
    controller.replace(controller.loadConversation(sides, { path: rootSave }));
    expect(controller.sessionPath).toBeNull();

    controller.append(user('and the lexer'));
    await settled(controller);
    expect(dirname(controller.sessionPath!)).toBe(projectDir());
    expect(await readFile(rootSave, 'utf8')).toBe('left as it was');
  });

  it('says so once when a save fails, and keeps the session going', async () => {
    // A file where the history root should be: every write under it fails.
    const blocked = join(root, 'not-a-dir');
    await writeFile(blocked, '');
    const { controller } = controllerIn('agent', { autosave: true }, 'default', blocked);
    controller.setStatus('idle');
    controller.append(user('first'));
    await settled(controller);
    controller.append(user('second'));
    await settled(controller);
    await settled(controller);

    const warnings = controller.messages.filter(m => m.role === 'system' && m.tone === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      content: expect.stringMatching(/^auto-save failed: .* — \/resume won't have this session/),
    });
  });
});
