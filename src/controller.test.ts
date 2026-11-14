import { describe, expect, it, vi } from 'vitest';
import { createController } from './controller.js';
import type { QueuedMessage } from './agent/busyqueue.js';
import type { Config, Message, Mode } from './types.js';

const user = (content: string): Message => ({ role: 'user', content });
const note = (content: string): Message => ({ role: 'system', content });

type Policy = Pick<Config, 'autoApprove' | 'autoApproveExplicit' | 'unattended'>;

// `off` unless a test says otherwise, so every approval request opens its dialog.
function controllerIn(mode: Mode, policy: Policy | null = { autoApprove: 'off' }) {
  const switchSide = vi.fn();
  return { controller: createController({ mode, switchSide, config: () => policy }), switchSide };
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

  it('takes a scrollback for the side that is off screen', () => {
    const { controller } = controllerIn('agent');
    const saved = [user('saved chat')];
    controller.stash('chat', saved);
    expect(controller.sides().chat).toBe(saved);
    controller.transition('chat');
    expect(controller.messages).toEqual(saved);
  });

  it('forgets the off-screen side when the stash is cleared', () => {
    const { controller } = controllerIn('agent');
    controller.append(user('agent task'));
    controller.transition('chat');
    controller.clearStash();
    controller.transition('agent');
    expect(controller.messages).toEqual([]);
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

  it('zeroes the counters on a reset and leaves the toggles alone', () => {
    const { controller } = controllerIn('agent');
    void controller.requestApproval(ordinary);
    controller.answerApproval(true, { always: true });
    controller.resetApprovals();
    expect(controller.getSnapshot().approvals).toEqual({ approved: 0, declined: 0 });
    expect(controller.getSnapshot().sessionAutoApprove).toBe(true);
  });
});
