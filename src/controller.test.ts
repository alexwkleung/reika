import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createController } from './controller.js';
import {
  listSessions,
  loadSession,
  newSessionPath,
  projectHistoryDir,
  writeSession,
} from './store/sessions.js';
import { TRANSCRIPT_VERSION, type TranscriptMeta } from './store/transcript.js';
import type * as Transcript from './store/transcript.js';
import type { QueuedMessage } from './agent/busyqueue.js';
import type * as Bash from './tools/bash.js';
import type * as Identity from './ui/identity.js';
import { setAtLaunch } from './config.js';
import type { LastState } from './laststate.js';
import ignore, { type Ignore } from 'ignore';
import type { McpCallFn, McpCommand } from './mcp/tools.js';
import type { createSession, Session, SessionOptions, SubmitOptions } from './session.js';
import type { Skill } from './skills/skills.js';
import type { Config, Message, Mode, Profile } from './types.js';

// A spawn that throws, which a real command cannot be made to do on demand.
const shellFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('./tools/bash.js', async importOriginal => {
  const real = await importOriginal<typeof Bash>();
  return {
    ...real,
    execStream: (...args: Parameters<typeof real.execStream>) => {
      const failure = shellFailure.next;
      shellFailure.next = null;
      return failure ? Promise.reject(failure) : real.execStream(...args);
    },
  };
});

// Every save builds its header once, which is how a test counts the save decisions a tick made.
const builtMeta = vi.hoisted(() => ({ calls: [] as { midTurn: boolean; msgs: unknown[] }[] }));
vi.mock('./store/transcript.js', async importOriginal => {
  const real = await importOriginal<typeof Transcript>();
  return {
    ...real,
    buildTranscriptMeta: (o: Parameters<typeof real.buildTranscriptMeta>[0]) => {
      builtMeta.calls.push({ midTurn: o.midTurn, msgs: o.msgs });
      return real.buildTranscriptMeta(o);
    },
  };
});

// Detection runs git in the session's cwd; the controller only has to pass on what it found.
vi.mock('./ui/identity.js', async importOriginal => {
  const real = await importOriginal<typeof Identity>();
  return {
    ...real,
    enableAnon: async () => {
      const found = { names: ['Mona Lisa'], emails: ['octocat@example.com'], slugs: [] };
      real.setIdentity(found as unknown as Parameters<typeof real.setIdentity>[0]);
      return found;
    },
  };
});

const user = (content: string): Message => ({ role: 'user', content });
const note = (content: string): Message => ({ role: 'system', content });

type Policy = Partial<Config>;

const profileOf = (model: string): Profile => ({
  model,
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
});

// The parts of a session the controller reads: its config and active profile, the turn it runs,
// the MCP call, and the calls that change it. `setProfile` reports one probe notice, as the real
// one does for a new window.
function fakeSession(config: Policy) {
  const cfg = {
    autoApprove: 'off',
    models: ['local'],
    profiles: { default: profileOf('local') },
    ...config,
  } as Config;
  // A turn as the real session runs one: bracketed, with the user's bubble first. A test swaps it
  // to drive the turn by hand.
  let turn = async (text: string, opts: SubmitOptions): Promise<Message[]> => {
    opts.onTurnStart?.();
    const bubble: Message = { role: 'user', content: opts.display ?? text };
    opts.events?.onMessage?.(bubble);
    opts.onTurnEnd?.();
    return [bubble];
  };
  const session = {
    profile: 'default',
    bundle: { cwd: '/repo/app', skills: [], fileIndex: [], ignore: ignore() } as {
      cwd: string;
      repoMapBudget?: number;
      skills?: Skill[];
      fileIndex?: string[];
      ignore?: Ignore;
    },
    config: cfg,
    shrink: { sheds: 0, folds: 0 },
    getSnapshot: () => ({ config: cfg }),
    set turn(next: typeof turn) {
      turn = next;
    },
    submit: vi.fn((text: string, opts: SubmitOptions) => turn(text, opts)),
    mcp: { call: vi.fn<McpCallFn>() },
    updateBundle: vi.fn((update: (b: { cwd: string }) => { cwd: string }) => {
      session.bundle = update(session.bundle);
    }),
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

// The header line of a saved file.
const headerOf = async (path: string): Promise<TranscriptMeta> =>
  JSON.parse((await readFile(path, 'utf8')).split('\n')[0]) as TranscriptMeta;

// `off` unless a test says otherwise, so every approval request opens its dialog. A null policy
// is a controller whose session has not booted.
function controllerIn(
  mode: Mode,
  policy: Policy | null = {},
  own = 'default',
  historyRoot?: string,
) {
  const remember = vi.fn<(state: LastState) => void>();
  const controller = createController({ mode, remember, historyRoot });
  const session = policy ? fakeSession(policy) : null;
  if (session) controller.attachSession(session as unknown as Session, own);
  return {
    controller,
    session,
    switchSide: session?.switchSide ?? vi.fn(),
    remember,
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
      error: null,
      usage: { promptTokens: 0, completionTokens: 0 },
      lastUsage: null,
      estimatedContext: null,
      shrink: { sheds: 0, folds: 0 },
      decodeRate: undefined,
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
    byDefault.setToggle('approvals', false);
    expect(byDefault.autoApprove).toBe('off');

    const forced = controllerIn('agent', {
      autoApprove: 'safe',
      autoApproveExplicit: true,
    }).controller;
    forced.setToggle('approvals', false);
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
    launchedOn.setToggle('unattended', false);
    expect(launchedOn.unattended).toBe(false);
    void launchedOn.requestApproval(ordinary);
    expect(launchedOn.approval).toBe(ordinary);

    const launchedOff = controllerIn('agent', { autoApprove: 'off' }).controller;
    launchedOff.setToggle('unattended', true);
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
    controller.setToggle('unattended', true);

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
    builtMeta.calls = [];
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
    const { controller } = saving();
    controller.setStatus('idle');
    controller.append(user('fix the parser'));
    await settled(controller);

    expect(dirname(controller.sessionPath!)).toBe(projectDir());
    expect((await loadSession(controller.sessionPath!)).agent).toEqual([user('fix the parser')]);
    const header = await headerOf(controller.sessionPath!);
    expect(header).toMatchObject({
      model: 'local',
      baseURL: 'http://127.0.0.1:1/v1',
      cwd: '/repo/app',
      mode: 'agent',
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    expect(header.midTurn).toBeUndefined();
  });

  it("writes the active profile and the turn's measurements into the header", async () => {
    const { controller, session } = controllerIn(
      'agent',
      {
        autosave: true,
        contextWindow: 32000,
        minGenTokens: 2048,
        profiles: { default: profileOf('local'), kimi: profileOf('kimi-k3') },
      },
      'default',
      root,
    );
    controller.setStatus('idle');
    controller.pickModel('kimi');
    session!.shrink = { sheds: 1, folds: 0 };
    session!.turn = async (text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onMessage!(user(text));
      opts.events!.onUsage!({ promptTokens: 900, completionTokens: 40, cachedTokens: 600 });
      opts.events!.onShrink!(
        { kind: 'age', round: 3, marked: 2, bulk: 2, crumbs: 0, kept: 1, short: 0 },
        { sheds: 1, folds: 0 },
      );
      opts.events!.onContextEstimate!(700);
      opts.events!.onMessage!(reply);
      opts.onTurnEnd?.();
      return [];
    };
    await controller.runTurn('fix the parser', {}, {});
    await settled(controller);

    const header = await headerOf(controller.sessionPath!);
    expect(header).toMatchObject({ model: 'kimi-k3', cwd: '/repo/app' });
    expect(header.usage).toEqual({
      turns: 1,
      promptTokens: 900,
      completionTokens: 40,
      cachedTokens: 600,
      // The shed cleared the last real count, so the gauge is the estimate after it.
      contextTokens: 700,
      contextEstimated: true,
      contextWindow: 32000,
      contextUsable: expect.any(Number),
      sheds: 1,
      folds: 0,
      shrinkEvents: [
        { turn: 1, kind: 'age', round: 3, marked: 2, bulk: 2, crumbs: 0, kept: 1, short: 0 },
      ],
    });
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
    const { controller } = saving();
    controller.setStatus('idle');
    controller.append(user('a'));
    controller.append(reply);
    controller.append(note('receipt'));
    await Promise.resolve();
    expect(builtMeta.calls).toHaveLength(1);
    await controller.saveNow();
  });

  it('saves at once on the first prompt of a turn, then at most once per interval while it runs', async () => {
    vi.useFakeTimers();
    const { controller } = saving();
    controller.setStatus('busy');
    controller.append(user('long task'));
    await Promise.resolve();
    expect(builtMeta.calls).toEqual([{ midTurn: true, msgs: [user('long task')] }]);

    controller.append(reply);
    await Promise.resolve();
    controller.append(reply);
    await Promise.resolve();
    expect(builtMeta.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(builtMeta.calls).toHaveLength(2);
    expect(builtMeta.calls.at(-1)?.midTurn).toBe(true);

    controller.setStatus('idle');
    await Promise.resolve();
    expect(builtMeta.calls).toHaveLength(3);
    vi.useRealTimers();
    await controller.saveNow();
    expect((await headerOf(controller.sessionPath!)).midTurn).toBeUndefined();
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
    const { controller } = saving();
    controller.setStatus('idle');
    const path = join(projectDir(), 'earlier.jsonl');
    const sides = { agent: [user('fix the parser'), reply], chat: [] };
    controller.replace(controller.loadConversation(sides, { path }));
    await settled(controller);
    expect(controller.sessionPath).toBe(path);
    expect(builtMeta.calls).toEqual([]);

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

describe('controller toggles', () => {
  const echo: Message = { role: 'user', content: '/approvals on', meta: true };

  it('resolves a typed toggle against the live state, and nothing else', () => {
    const { controller } = controllerIn('agent', { autoApprove: 'safe' });
    expect(controller.toggleCommand('approvals', 'off')).toEqual({
      kind: 'set',
      toggle: 'approvals',
      on: false,
    });
    expect(controller.toggleCommand('approvals', '')).toMatchObject({
      kind: 'ask',
      currentlyOn: true,
    });
    expect(controller.toggleCommand('unattended', '')).toMatchObject({ currentlyOn: false });
    expect(controller.toggleCommand('model', '')).toBeNull();

    void controller.setToggle('approvals', false);
    void controller.setToggle('unattended', true);
    expect(controller.toggleCommand('approvals', '')).toMatchObject({ currentlyOn: false });
    expect(controller.toggleCommand('unattended', '')).toMatchObject({ currentlyOn: true });
  });

  it('answers an env-forced /approvals with a line instead of a switch', () => {
    const { controller } = controllerIn('agent', {
      autoApprove: 'bypass',
      autoApproveExplicit: true,
    });
    expect(controller.toggleCommand('approvals', 'off')).toMatchObject({
      kind: 'reply',
      content: expect.stringContaining("forced to 'bypass'"),
    });
    expect(controller.toggleCommand('approvals', '')).toMatchObject({
      kind: 'reply',
      content: expect.stringContaining('auto-approve: bypass'),
    });
  });

  it('prints the receipt under the echo when a switch is flipped', async () => {
    const { controller } = controllerIn('agent');
    await controller.setToggle('approvals', true, echo);
    expect(controller.getSnapshot().sessionAutoApprove).toBe(true);
    expect(controller.messages).toEqual([echo, note('Session auto-approve: on')]);

    await controller.setToggle('unattended', true);
    expect(controller.messages.at(-1)).toMatchObject({
      content: expect.stringMatching(/^unattended: on/),
    });
  });

  it('turns anonymize on with what it found, and off again', async () => {
    const { controller } = controllerIn('agent');
    await controller.setToggle('anon', true);
    expect(controller.toggleCommand('anon', '')).toMatchObject({ currentlyOn: true });
    expect(controller.messages.at(-1)).toMatchObject({
      content: expect.stringContaining('substituting 1 name(s) → <user>, 1 email(s) → <email>'),
    });

    await controller.setToggle('anon', false);
    expect(controller.toggleCommand('anon', '')).toMatchObject({ currentlyOn: false });
    expect(controller.messages.at(-1)).toMatchObject({
      content: expect.stringMatching(/^anonymize: off/),
    });
  });
});

describe('controller commands on disk', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'reika-controller-cmd-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const echo = (content: string): Message => ({ role: 'user', content, meta: true });
  const reply: Message = { role: 'assistant', content: 'done' };
  const inRoot = (mode: Mode = 'agent', policy: Policy = {}) =>
    controllerIn(mode, policy, 'default', root);
  const lines = (messages: Message[]): string[] =>
    messages.filter(m => m.role === 'system').map(m => m.content);

  describe('changeDirectory', () => {
    it('asks for a path when given none', async () => {
      const { controller, session } = inRoot();
      await controller.changeDirectory('  ', echo('/cd'));
      expect(controller.messages).toEqual([echo('/cd'), note('Usage: /cd <path>')]);
      expect(session!.updateBundle).not.toHaveBeenCalled();
    });

    it('re-indexes a path relative to the current project and moves the session there', async () => {
      await mkdir(join(root, 'app', 'pkg'), { recursive: true });
      await writeFile(join(root, 'app', 'pkg', 'index.ts'), 'export const a = 1;\n');
      const { controller, session } = inRoot();
      session!.bundle = { cwd: join(root, 'app') };
      controller.setStatus('idle');

      const moving = controller.changeDirectory('pkg', echo('/cd pkg'));
      expect(controller.status).toBe('busy');
      await moving;

      const target = join(root, 'app', 'pkg');
      expect(session!.bundle.cwd).toBe(target);
      expect(controller.status).toBe('idle');
      expect(controller.messages).toEqual([
        echo('/cd pkg'),
        note(`Re-indexing ${target}…`),
        note(`cwd is now ${target}`),
      ]);
    });

    it('says why and stays put when the path cannot be indexed', async () => {
      const { controller, session } = inRoot();
      controller.setStatus('idle');
      await controller.changeDirectory(join(root, 'missing'), echo('/cd missing'));
      expect(session!.bundle.cwd).toBe('/repo/app');
      expect(controller.status).toBe('idle');
      expect(lines(controller.messages).at(-1)).toMatch(/^cd failed: /);
    });
  });

  describe('saveTranscript', () => {
    it('says there is nothing to save on an empty scrollback', async () => {
      const { controller } = inRoot();
      await controller.saveTranscript(false, echo('/save'));
      expect(controller.messages).toEqual([echo('/save'), note('Nothing to save yet.')]);
    });

    it('writes the scrollback on screen to the history root and names both files', async () => {
      const { controller } = inRoot();
      controller.setStatus('idle');
      controller.append(user('fix the parser'), reply);
      await controller.saveTranscript(false, echo('/save'));

      const receipt = lines(controller.messages).at(-1)!;
      const [, jsonlPath, txtPath] = /^saved 2 messages → (.+)\n\(\+ (.+)\)$/.exec(receipt)!;
      expect(dirname(jsonlPath)).toBe(root);
      expect((await loadSession(jsonlPath)).agent).toEqual([user('fix the parser'), reply]);
      expect(await readFile(txtPath, 'utf8')).toContain('fix the parser');
      const header = await headerOf(jsonlPath);
      expect(header).toMatchObject({
        model: 'local',
        baseURL: 'http://127.0.0.1:1/v1',
        cwd: '/repo/app',
        messageCount: 2,
        usage: { turns: 1, promptTokens: 0, completionTokens: 0 },
      });
      expect(header.midTurn).toBeUndefined();
    });

    it('marks a raw save and a mid-turn one in the receipt', async () => {
      const { controller } = inRoot();
      controller.append(user('fix the parser'));
      controller.setStatus('busy');
      await controller.saveTranscript(true, echo('/save --raw'));
      const receipt = lines(controller.messages).at(-1)!;
      expect(receipt).toMatch(
        /^saved 1 messages \(raw, unredacted\) — mid-turn, up to the last completed round; the turn continues → /,
      );
      const jsonlPath = /→ (.+)\n/.exec(receipt)![1];
      expect(await headerOf(jsonlPath)).toMatchObject({ midTurn: true, cwd: '/repo/app' });
    });

    it('reports a save that could not be written', async () => {
      const blocked = join(root, 'not-a-dir');
      await writeFile(blocked, '');
      const { controller } = controllerIn('agent', {}, 'default', blocked);
      controller.append(user('fix the parser'));
      await controller.saveTranscript(false, echo('/save'));
      expect(controller.messages.at(-1)).toMatchObject({
        role: 'error',
        content: expect.stringMatching(/^save failed: /),
      });
    });
  });

  describe('resumeList', () => {
    const settled = async (controller: { saveNow(): Promise<void> }): Promise<void> => {
      await Promise.resolve();
      await controller.saveNow();
    };
    // One finished conversation in the project's directory. Written directly: a second
    // controller in this process would claim the same first file name (#761).
    const savedSession = async (side: 'agent' | 'chat', prompt: string): Promise<string> => {
      const path = newSessionPath(projectHistoryDir('/repo/app', root), new Date(), side);
      const turns = [user(prompt), reply];
      const sides = side === 'chat' ? { agent: [], chat: turns } : { agent: turns, chat: [] };
      await writeSession(path, sides, metaFor(sides.agent, '/repo/app', false));
      return path;
    };

    it('refuses while a turn runs, and on an argument it does not know', async () => {
      const { controller } = inRoot();
      controller.setStatus('busy');
      expect(await controller.resumeList('')).toEqual({
        reply: 'Cannot resume while busy. Wait or ctrl-c to abort.',
      });
      controller.setStatus('idle');
      expect(await controller.resumeList('everything')).toMatchObject({
        reply: expect.stringMatching(/^Usage: \/resume /),
      });
    });

    it("lists the project's sessions without the one in progress", async () => {
      const earlier = await savedSession('agent', 'fix the parser');
      const { controller } = inRoot('agent', { autosave: true });
      controller.setStatus('idle');
      controller.append(user('and the lexer'), reply);
      await settled(controller);

      const list = await controller.resumeList('');
      expect(list).toMatchObject({ heading: 'this project' });
      expect('entries' in list && list.entries.map(e => e.path)).toEqual([earlier]);
    });

    it('lists only chats in chat mode, and everything for /resume all', async () => {
      await savedSession('agent', 'fix the parser');
      const chat = await savedSession('chat', 'what is a monad');
      const { controller } = inRoot('chat');
      controller.setStatus('idle');

      const chats = await controller.resumeList('');
      expect(chats).toMatchObject({ heading: 'chats in this project' });
      expect('entries' in chats && chats.entries.map(e => e.path)).toEqual([chat]);
      const all = await controller.resumeList('all');
      expect('entries' in all && all.entries).toHaveLength(2);
    });

    it('falls back to the manual saves when the project has none, and says so', async () => {
      const { controller } = inRoot();
      controller.setStatus('idle');
      controller.append(user('fix the parser'), reply);
      await controller.saveTranscript(false, echo('/save'));

      const fallback = await controller.resumeList('');
      expect(fallback).toMatchObject({ heading: 'none for this project — saved with /save' });
      expect('entries' in fallback && fallback.entries).toHaveLength(1);
      expect(await controller.resumeList('root')).toMatchObject({ heading: 'saved with /save' });
    });

    it('says what is missing when there is nothing to list', async () => {
      const off = inRoot().controller;
      off.setStatus('idle');
      expect(await off.resumeList('')).toEqual({
        reply: 'No saved sessions for this project (auto-save is off: REIKA_AUTOSAVE=0).',
      });
      expect(await off.resumeList('root')).toEqual({ reply: `No saved sessions in ${root}.` });

      const on = inRoot('agent', { autosave: true }).controller;
      on.setStatus('idle');
      expect(await on.resumeList('')).toEqual({
        reply: 'No saved sessions for this project yet.',
      });

      const chat = inRoot('chat', { autosave: true }).controller;
      chat.setStatus('idle');
      expect(await chat.resumeList('')).toEqual({
        reply: 'No saved chats for this project. /resume all lists every session.',
      });
    });
  });
});

describe('controller.runTurn', () => {
  const lastSubmit = (session: ReturnType<typeof fakeSession>) => session.submit.mock.calls.at(-1)!;

  it('runs nothing before the session has booted', async () => {
    const { controller } = controllerIn('agent', null);
    expect(await controller.runTurn('hi', {}, {})).toEqual([]);
  });

  it("hands the session the turn's options, recorded as the controller's mode", async () => {
    const { controller, session } = controllerIn('vibe');
    const nativeImages = [{ marker: '[Image 1]', mime: 'image/png', bytes: new Uint8Array([1]) }];
    await controller.runTurn(
      'implement the plan',
      { mode: 'agent', display: '/implement', skill: 'issue', nativeImages, manualCompact: true },
      {},
    );
    const [text, opts] = lastSubmit(session!);
    expect(text).toBe('implement the plan');
    expect(opts).toMatchObject({
      mode: 'agent',
      recordAs: 'vibe',
      display: '/implement',
      skill: 'issue',
      nativeImages,
      manualCompact: true,
    });

    await controller.runTurn('fix it', {}, {});
    expect(lastSubmit(session!)[1]).toMatchObject({ mode: 'vibe', recordAs: 'vibe' });
  });

  it("runs with no gate under bypass, the front end's wrapper when given, and its own otherwise", async () => {
    const bypass = controllerIn('agent', { autoApprove: 'bypass' });
    await bypass.controller.runTurn('x', {}, {});
    expect(lastSubmit(bypass.session!)[1].requestApproval).toBeUndefined();

    const { controller, session } = controllerIn('agent', { autoApprove: 'off' });
    const requestApproval = vi.fn(async () => true as const);
    const requestQuestion = vi.fn(async () => null);
    await controller.runTurn('x', {}, { requestApproval, requestQuestion });
    expect(lastSubmit(session!)[1]).toMatchObject({ requestApproval, requestQuestion });

    await controller.runTurn('x', {}, {});
    const own = lastSubmit(session!)[1];
    const request = { tool: 'edit', subject: 'a.ts', preview: '+ x' };
    void own.requestApproval!(request);
    expect(controller.approval).toBe(request);
    void own.requestQuestion!({ question: 'Which?', options: [{ label: 'A' }] });
    expect(controller.question).toMatchObject({ question: 'Which?' });
  });

  it('reads unattended live, so a toggle mid-turn applies to the next action', async () => {
    const { controller, session } = controllerIn('agent');
    await controller.runTurn('x', {}, {});
    const { isUnattended } = lastSubmit(session!)[1];
    expect(isUnattended!()).toBe(false);
    await controller.setToggle('unattended', true);
    expect(isUnattended!()).toBe(true);
  });

  it('is busy for the turn, with the hooks inside the busy spell', async () => {
    const { controller, session } = controllerIn('agent');
    controller.setStatus('idle');
    const seen: string[] = [];
    const statusAt = (label: string) => () => seen.push(`${label}:${controller.status}`);
    session!.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      seen.push(`running:${controller.status}`);
      opts.onTurnEnd?.();
      seen.push(`ended:${controller.status}`);
      return [];
    };
    await controller.runTurn(
      'x',
      {},
      { onTurnStart: statusAt('start'), onTurnEnd: statusAt('end') },
    );
    expect(seen).toEqual(['start:busy', 'running:busy', 'end:busy', 'ended:idle']);
  });

  it('aborts the running turn through the signal it handed the session, and nothing when idle', async () => {
    const { controller, session } = controllerIn('agent');
    controller.setStatus('idle');
    expect(controller.abort()).toBe(false);
    let signal: AbortSignal | void = undefined;
    session!.turn = async (_text, opts) => {
      signal = opts.onTurnStart?.();
      expect(controller.abort()).toBe(true);
      opts.onTurnEnd?.();
      return [];
    };
    await controller.runTurn('x', {}, {});
    expect((signal as AbortSignal | undefined)?.aborted).toBe(true);
    expect(controller.abort()).toBe(false);
  });

  it('puts the notices right after the first user message, once', async () => {
    const { controller, session } = controllerIn('agent');
    const receipt = note('Skill /issue applied');
    const seen: Message[] = [];
    session!.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onMessage!(user('/issue 14'));
      opts.events!.onMessage!({ role: 'assistant', content: 'on it' });
      opts.events!.onMessage!(user('and more'));
      opts.onTurnEnd?.();
      return [];
    };
    await controller.runTurn('body', { notices: [receipt] }, { onMessage: m => seen.push(m) });
    expect(controller.messages).toEqual([
      user('/issue 14'),
      receipt,
      { role: 'assistant', content: 'on it' },
      user('and more'),
    ]);
    // The front end hears the turn's own messages, not the receipts.
    expect(seen).toHaveLength(3);
  });

  it('prints a failed turn, and rolls up what an unattended session declined at the end', async () => {
    const { controller, session } = controllerIn('agent', { autoApprove: 'off', unattended: true });
    session!.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      await controller.requestApproval({ tool: 'bash', subject: 'npm test', preview: 'npm test' });
      opts.onTurnError?.(new Error('connection refused'));
      opts.onTurnEnd?.();
      return [];
    };
    await controller.runTurn('x', {}, {});
    expect(controller.messages[0]).toEqual({ role: 'error', content: 'connection refused' });
    expect(controller.messages[1]).toMatchObject({
      role: 'system',
      tone: 'warn',
      content: expect.stringContaining('npm test'),
    });
    expect(controller.takeUnattendedDeclines()).toEqual([]);
  });

  it('adds the files a tool wrote to the file index, and nothing from outside the project', async () => {
    const { controller, session } = controllerIn('agent');
    session!.turn = async (_text, opts) => {
      opts.onTurnStart?.();
      opts.events!.onMessage!({
        role: 'tool',
        callId: 'call-1',
        summary: 'Wrote src/new.ts',
        diff: { text: '+ x', path: 'src/new.ts', added: 1, removed: 0 },
        changes: {
          files: [
            { path: 'src/made.ts', kind: 'added', added: 1, removed: 0 },
            { path: 'src/gone.ts', kind: 'deleted', added: 0, removed: 1 },
            { path: '../elsewhere.ts', kind: 'added', added: 1, removed: 0 },
          ],
          more: 0,
        },
      } as unknown as Message);
      opts.onTurnEnd?.();
      return [];
    };
    await controller.runTurn('x', {}, {});
    expect(session!.updateBundle).toHaveBeenCalledTimes(1);
    expect(session!.bundle.fileIndex).toEqual(['src/made.ts', 'src/new.ts']);
  });
});

describe('controller measurements', () => {
  const profiles = { default: profileOf('local'), kimi: profileOf('kimi-k3') };
  type Events = NonNullable<SubmitOptions['events']>;
  // A turn that hands its events to `drive` between its brackets.
  const turnWith =
    (drive: (events: Events) => void) =>
    async (_text: string, opts: SubmitOptions): Promise<Message[]> => {
      opts.onTurnStart?.();
      drive(opts.events!);
      opts.onTurnEnd?.();
      return [];
    };
  const fold = { kind: 'fold', round: 4, removed: 6, recapChars: 900 } as const;

  it('adds each round to the total, and keeps the last real count apart from an estimate', async () => {
    const { controller, session } = controllerIn('agent');
    const heard = vi.fn();
    const counts: ReturnType<typeof controller.getSnapshot>[] = [];
    session!.turn = turnWith(e => {
      e.onUsage!({ promptTokens: 1000, completionTokens: 50, cachedTokens: 800 });
      counts.push(controller.getSnapshot());
      e.onUsage!({ promptTokens: 1200, completionTokens: 30 });
      counts.push(controller.getSnapshot());
      e.onUsage!({ promptTokens: 1300, completionTokens: 20, estimated: true });
    });
    await controller.runTurn('x', {}, { events: { onUsage: heard } });

    expect(counts[0]).toMatchObject({
      usage: { promptTokens: 1000, completionTokens: 50, cachedTokens: 800 },
      lastUsage: { promptTokens: 1000, completionTokens: 50, cachedTokens: 800 },
    });
    // A round that reports no cache count leaves the total's as it was.
    expect(counts[1].usage).toEqual({
      promptTokens: 2200,
      completionTokens: 80,
      cachedTokens: 800,
    });
    expect(controller.getSnapshot()).toMatchObject({
      usage: { promptTokens: 3500, completionTokens: 100, cachedTokens: 800, estimated: true },
      lastUsage: { promptTokens: 1200, completionTokens: 30 },
    });
    expect(heard).toHaveBeenCalledTimes(3);
    expect(heard).toHaveBeenLastCalledWith({
      promptTokens: 1300,
      completionTokens: 20,
      estimated: true,
    });
  });

  it('carries the total over to the next turn, and adds no cache count nobody reported', async () => {
    const { controller, session } = controllerIn('agent');
    session!.turn = turnWith(e => e.onUsage!({ promptTokens: 10, completionTokens: 1 }));
    await controller.runTurn('x', {}, {});
    await controller.runTurn('y', {}, {});
    expect(controller.getSnapshot().usage).toEqual({ promptTokens: 20, completionTokens: 2 });
  });

  it('records the pre-send estimate and the decode rate, and passes both on', async () => {
    const { controller, session } = controllerIn('agent');
    const onContextEstimate = vi.fn();
    const onDecodeRate = vi.fn();
    session!.turn = turnWith(e => {
      e.onContextEstimate!(4200);
      e.onDecodeRate!(21.5);
    });
    await controller.runTurn('x', {}, { events: { onContextEstimate, onDecodeRate } });
    expect(controller.getSnapshot()).toMatchObject({ estimatedContext: 4200, decodeRate: 21.5 });
    expect(onContextEstimate).toHaveBeenCalledWith(4200);
    expect(onDecodeRate).toHaveBeenCalledWith(21.5);
  });

  it('counts a shrink, drops the stale real count, and stamps the event with its turn', async () => {
    const { controller, session } = controllerIn('agent');
    const onShrink = vi.fn();
    session!.turn = turnWith(e => {
      e.onUsage!({ promptTokens: 9000, completionTokens: 10 });
      e.onMessage!({ role: 'assistant', content: 'first' });
      e.onMessage!({ role: 'assistant', content: 'second' });
      e.onShrink!(fold, { sheds: 0, folds: 1 });
    });
    await controller.runTurn('x', {}, { events: { onShrink } });
    expect(controller.getSnapshot()).toMatchObject({
      shrink: { sheds: 0, folds: 1 },
      lastUsage: null,
      usage: { promptTokens: 9000, completionTokens: 10 },
    });
    expect(onShrink).toHaveBeenCalledWith(fold, { sheds: 0, folds: 1 });
  });

  // A turn that leaves every measurement set.
  const measured = turnWith(e => {
    e.onUsage!({ promptTokens: 500, completionTokens: 5 });
    e.onContextEstimate!(600);
    e.onDecodeRate!(30);
    e.onShrink!(fold, { sheds: 0, folds: 1 });
    e.onUsage!({ promptTokens: 100, completionTokens: 5 });
  });
  const blank = {
    usage: { promptTokens: 0, completionTokens: 0 },
    lastUsage: null,
    estimatedContext: null,
    shrink: { sheds: 0, folds: 0 },
  };

  it('starts a new conversation with nothing measured', async () => {
    const { controller, session } = controllerIn('agent');
    session!.turn = measured;
    await controller.runTurn('x', {}, {});
    controller.newConversation({ role: 'user', content: '/new', meta: true });
    expect(controller.getSnapshot()).toMatchObject({ ...blank, decodeRate: undefined });
  });

  it('drops the counts on a resume and keeps the decode rate of the model still on', async () => {
    const { controller, session } = controllerIn('agent');
    session!.turn = measured;
    await controller.runTurn('x', {}, {});
    controller.loadConversation({ agent: [user('earlier')], chat: [] }, { path: '/h/a.jsonl' });
    expect(controller.getSnapshot()).toMatchObject({ ...blank, decodeRate: 30 });
  });

  it('drops the decode rate when a resume brings another model with its mode', async () => {
    const { controller, session } = controllerIn('chat', {
      profiles,
      modeProfiles: { agent: 'kimi' },
    });
    session!.turn = measured;
    await controller.runTurn('x', {}, {});
    controller.loadConversation({ agent: [user('earlier')], chat: [] }, { path: '/h/a.jsonl' });
    expect(session!.profile).toBe('kimi');
    expect(controller.getSnapshot().decodeRate).toBeUndefined();
  });

  it('drops the decode rate on a picked model, even the one already on, and keeps the counts', async () => {
    const { controller, session } = controllerIn('agent', { profiles });
    session!.turn = measured;
    await controller.runTurn('x', {}, {});
    controller.pickModel('default');
    expect(controller.getSnapshot()).toMatchObject({
      decodeRate: undefined,
      usage: { promptTokens: 600, completionTokens: 10 },
    });
  });

  it('drops the decode rate when a mode brings its own model, and not when the model stays', async () => {
    const { controller, session } = controllerIn('agent', {
      profiles,
      modeProfiles: { plan: 'kimi' },
    });
    session!.turn = measured;
    await controller.runTurn('x', {}, {});
    controller.transition('grind');
    expect(controller.getSnapshot().decodeRate).toBe(30);
    controller.transition('plan');
    expect(controller.getSnapshot().decodeRate).toBeUndefined();
  });
});

describe('controller.submitPrompt', () => {
  const answers = {};
  const input = (
    overrides: Partial<Parameters<ReturnType<typeof createController>['submitPrompt']>[1]> = {},
  ) => ({
    answers,
    images: [],
    pastes: [],
    onStage: vi.fn(),
    ...overrides,
  });

  it('sends a plain prompt as typed, and clears the stage at the end', async () => {
    const { controller, session } = controllerIn('agent');
    const typed = input({ onBuilt: vi.fn() });
    await controller.submitPrompt('fix the parser', typed, {});
    const [text, opts] = session!.submit.mock.calls[0];
    expect(text).toBe('fix the parser');
    expect(opts).toMatchObject({ mode: 'agent', display: undefined, skill: undefined });
    expect(typed.onBuilt).toHaveBeenCalledTimes(1);
    expect(typed.onStage).toHaveBeenLastCalledWith(null);
    expect(controller.messages).toEqual([user('fix the parser')]);
  });

  it('applies a routed skill and prints its receipt under the bubble', async () => {
    const { controller, session } = controllerIn('agent');
    session!.bundle.skills = [
      {
        name: 'issue',
        description: 'Work on an issue',
        body: 'Run gh issue view.',
        source: 'bundled',
        path: '/repo/app/skills/issue.md',
        triggers: ['work on issue'],
      },
    ];
    await controller.submitPrompt('work on issue 14', input({ answers: { skill: 'issue' } }), {});
    const [text, opts] = session!.submit.mock.calls[0];
    expect(text).toBe('Run gh issue view.\n\nwork on issue 14');
    expect(opts).toMatchObject({ skill: 'issue', display: 'work on issue 14' });
    expect(controller.messages[1]).toMatchObject({
      role: 'system',
      content: expect.stringMatching(/^Skill \/issue applied/),
    });
  });

  it('runs vibe mode as the vibe chain', async () => {
    const { controller, session } = controllerIn('vibe');
    await controller.submitPrompt('add a flag', input(), {});
    expect(session!.submit.mock.calls[0][1]).toMatchObject({ mode: 'vibe' });
  });

  it('drops a second prompt while the first is still expanding', async () => {
    const { controller, session } = controllerIn('agent');
    const first = controller.submitPrompt('one', input(), {});
    await controller.submitPrompt('two', input(), {});
    await first;
    expect(session!.submit.mock.calls.map(c => c[0])).toEqual(['one']);
  });
});

describe('controller shell runs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'reika-controller-shell-')));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const inCwd = (mode: Mode = 'shell') => {
    const made = controllerIn(mode);
    made.session!.bundle.cwd = cwd;
    made.controller.setStatus('idle');
    return made;
  };
  const shellFront = () => {
    const seen: string[] = [];
    return {
      seen,
      front: {
        onStart: vi.fn(),
        onProgress: (chunk: string) => seen.push(chunk),
        onEnd: vi.fn(),
      },
    };
  };

  it('echoes the command, streams its output, shows it and goes idle', async () => {
    const { controller } = inCwd();
    const { seen, front } = shellFront();
    const statuses: string[] = [];
    controller.subscribe(() => statuses.push(controller.status));
    await controller.runShell('echo hi', front);
    expect(controller.messages[0]).toEqual({ role: 'user', content: 'echo hi', meta: true });
    expect(controller.messages[1]).toMatchObject({ role: 'shell', command: 'echo hi' });
    expect((controller.messages[1] as { output: string }).output).toContain('hi');
    expect(seen.join('')).toContain('hi');
    expect(front.onStart).toHaveBeenCalledTimes(1);
    expect(front.onEnd).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('busy');
    expect(controller.status).toBe('idle');
  });

  it('holds the run for the next prompt, once', async () => {
    const { controller, session } = inCwd();
    await controller.runShell('echo hi', shellFront().front);
    controller.setMode('agent');
    await controller.submitPrompt(
      'what did that print?',
      { answers: {}, images: [], pastes: [], onStage: () => {} },
      {},
    );
    await controller.submitPrompt(
      'and now?',
      { answers: {}, images: [], pastes: [], onStage: () => {} },
      {},
    );
    const [first, second] = session!.submit.mock.calls.map(c => c[0]);
    expect(first).toContain('echo hi');
    expect(first).toMatch(/what did that print\?$/);
    expect(second).toBe('and now?');
  });

  it('keeps the run for the agent side while in chat', async () => {
    const { controller, session } = inCwd();
    await controller.runShell('echo hi', shellFront().front);
    controller.setMode('chat');
    await controller.submitPrompt(
      'a question',
      { answers: {}, images: [], pastes: [], onStage: () => {} },
      {},
    );
    controller.setMode('agent');
    await controller.submitPrompt(
      'a task',
      { answers: {}, images: [], pastes: [], onStage: () => {} },
      {},
    );
    const [chat, agent] = session!.submit.mock.calls.map(c => c[0]);
    expect(chat).toBe('a question');
    expect(agent).toContain('echo hi');
  });

  it('drops the held runs with a new conversation', async () => {
    const { controller, session } = inCwd();
    await controller.runShell('echo hi', shellFront().front);
    controller.newConversation({ role: 'user', content: '/new', meta: true });
    await controller.submitPrompt(
      'a task',
      { answers: {}, images: [], pastes: [], onStage: () => {} },
      {},
    );
    expect(session!.submit.mock.calls[0][0]).toBe('a task');
  });

  it('prints an error when the command cannot run, and still goes idle', async () => {
    const { controller } = inCwd();
    shellFailure.next = new Error('spawn /bin/sh ENOENT');
    const { front } = shellFront();
    await controller.runShell('echo hi', front);
    expect(controller.messages.at(-1)).toEqual({ role: 'error', content: 'spawn /bin/sh ENOENT' });
    expect(controller.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(front.onEnd).toHaveBeenCalledTimes(1);
    expect(controller.status).toBe('idle');
  });
});

describe('controller.runMcpCommand', () => {
  const command: McpCommand = {
    name: 'files:read_file',
    server: 'files',
    tool: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  };

  it('prints why the arguments are wrong and calls nothing', async () => {
    const { controller, session } = controllerIn('agent');
    await controller.runMcpCommand('/files:read_file {oops', command, '{oops');
    expect(controller.messages).toEqual([
      expect.objectContaining({ role: 'system', tone: 'warn' }),
    ]);
    expect(session!.mcp.call).not.toHaveBeenCalled();
  });

  it('shows the result as a shell message', async () => {
    const { controller, session } = controllerIn('agent');
    controller.setStatus('idle');
    session!.mcp.call.mockResolvedValue({
      content: [{ type: 'text', text: 'hello from the file' }],
    });
    const raw = '/files:read_file {"path":"src/a.ts"}';
    await controller.runMcpCommand(raw, command, '{"path":"src/a.ts"}');
    expect(session!.mcp.call).toHaveBeenCalledWith(
      'files',
      'read_file',
      { path: 'src/a.ts' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.messages[0]).toMatchObject({ role: 'shell', command: raw });
    expect((controller.messages[0] as { output: string }).output).toContain('hello from the file');
    expect(controller.status).toBe('idle');
  });

  it('can be aborted while the call runs', async () => {
    const { controller, session } = controllerIn('agent');
    controller.setStatus('idle');
    session!.mcp.call.mockImplementation(
      (_server, _tool, _args, opts) =>
        new Promise((_resolve, reject) =>
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const running = controller.runMcpCommand('/files:read_file a.ts', command, '{"path":"a.ts"}');
    await Promise.resolve();
    expect(controller.status).toBe('busy');
    expect(controller.abort()).toBe(true);
    await running;
    expect(controller.status).toBe('idle');
    expect((controller.messages[0] as { output: string }).output).toContain('aborted');
  });
});

describe('controller.boot', () => {
  const profiles = {
    default: profileOf('local'),
    kimi: profileOf('kimi-k3'),
    go: profileOf('go-1'),
  };
  type Facts = {
    offline?: boolean;
    limitsNotice?: string;
    windowNotice?: string;
    searchNotice?: string;
    mcpNotices?: string[];
  };

  // A controller whose `createSession` hands back a fake session opened on the profile it was
  // asked for, with the given launch facts.
  function booting(mode: Mode, facts: Facts = {}) {
    const calls: string[] = [];
    let made: ReturnType<typeof fakeSession> | null = null;
    const create = vi.fn(async (o: SessionOptions) => {
      calls.push('createSession');
      made = Object.assign(fakeSession(o.config ?? {}), {
        offline: false,
        mcpNotices: [] as string[],
        ...facts,
      });
      made.profile = o.profile ?? 'default';
      return made as unknown as Session;
    });
    const controller = createController({
      mode,
      remember: vi.fn(),
      createSession: create as unknown as typeof createSession,
    });
    return { controller, create, calls, made: () => made };
  }
  const configOf = (policy: Policy): Config =>
    ({ autoApprove: 'off', models: ['local'], profiles, ...policy }) as Config;

  it('opens the session, prints the launch notices and ends idle', async () => {
    const { controller, create, calls, made } = booting('agent', {
      windowNotice: 'no window',
      mcpNotices: ['MCP: 1 server, 2 tools'],
    });
    const onConfig = vi.fn(() => calls.push('onConfig'));
    const onSession = vi.fn(() => {
      calls.push('onSession');
      // Nothing is on screen yet, so a header painted here lands above the notices.
      expect(controller.messages).toEqual([]);
    });
    const s = await controller.boot({
      cwd: '/repo/app',
      loadConfig: () => configOf({}),
      lastState: {},
      defaultMode: 'agent',
      onConfig,
      onSession,
    });
    expect(calls).toEqual(['onConfig', 'createSession', 'onSession']);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/app', profile: 'default', canAsk: true }),
    );
    expect(s).toBe(made());
    expect(controller.session).toBe(s);
    expect(onSession).toHaveBeenCalledWith(s, { profile: 'default', own: 'default' });
    expect(controller.messages).toEqual([
      { role: 'system', content: 'no window', tone: 'warn', skipAutosave: true },
      { role: 'system', content: 'MCP: 1 server, 2 tools', tone: 'info', skipAutosave: true },
    ]);
    expect(controller.status).toBe('idle');
    expect(controller.getSnapshot().error).toBeNull();

    controller.pickModel('kimi');
    expect(made()?.setProfile).toHaveBeenCalledWith('kimi');
  });

  it('prints nothing when the launch has nothing to say', async () => {
    const { controller } = booting('agent');
    await controller.boot({
      cwd: '/repo/app',
      loadConfig: () => configOf({}),
      lastState: {},
      defaultMode: 'agent',
    });
    expect(controller.messages).toEqual([]);
    expect(controller.status).toBe('idle');
  });

  // A REIKA_MODEL exported in the shell running the suite pins the start profile to the default.
  it.skipIf(setAtLaunch('REIKA_MODEL'))(
    "opens on the start mode's own model and comes back to the session's",
    async () => {
      const { controller, create, made } = booting('plan');
      const onSession = vi.fn();
      await controller.boot({
        cwd: '/repo/app',
        loadConfig: () => configOf({ model: 'kimi-k3', modeProfiles: { plan: 'kimi' } }),
        lastState: { profile: 'go' },
        defaultMode: 'agent',
        onSession,
      });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ profile: 'kimi' }));
      expect(onSession).toHaveBeenCalledWith(made(), { profile: 'kimi', own: 'go' });
      expect(controller.messages.map(m => (m as { content: string }).content)).toEqual([
        "Resumed plan mode and profile 'kimi' (kimi-k3) from the last session.",
      ]);

      controller.transition('agent');
      expect(made()?.profile).toBe('go');
    },
  );

  it('does not offer ask_user to an unattended session', async () => {
    const { controller, create } = booting('agent');
    await controller.boot({
      cwd: '/repo/app',
      loadConfig: () => configOf({ unattended: true }),
      lastState: {},
      defaultMode: 'agent',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ canAsk: false }));
  });

  it('ends in error when the config cannot be loaded', async () => {
    const { controller, create } = booting('agent');
    const onConfig = vi.fn();
    const s = await controller.boot({
      cwd: '/repo/app',
      loadConfig: () => {
        throw new Error('REIKA_MODEL is not set');
      },
      lastState: {},
      defaultMode: 'agent',
      onConfig,
    });
    expect(s).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(onConfig).not.toHaveBeenCalled();
    expect(controller.status).toBe('error');
    expect(controller.getSnapshot().error).toBe('REIKA_MODEL is not set');
    expect(controller.messages).toEqual([]);
    expect(controller.session).toBeNull();
  });

  it('ends in error when the session cannot be created', async () => {
    const { controller, create } = booting('agent', { windowNotice: 'no window' });
    create.mockRejectedValueOnce(new Error('bootstrap failed'));
    const onSession = vi.fn();
    const s = await controller.boot({
      cwd: '/repo/app',
      loadConfig: () => configOf({}),
      lastState: {},
      defaultMode: 'agent',
      onSession,
    });
    expect(s).toBeNull();
    expect(onSession).not.toHaveBeenCalled();
    expect(controller.status).toBe('error');
    expect(controller.getSnapshot().error).toBe('bootstrap failed');
    expect(controller.messages).toEqual([]);
  });
});
