import { describe, expect, it, vi } from 'vitest';
import { createController } from './controller.js';
import type { Message, Mode } from './types.js';

const user = (content: string): Message => ({ role: 'user', content });
const note = (content: string): Message => ({ role: 'system', content });

function controllerIn(mode: Mode) {
  const switchSide = vi.fn();
  return { controller: createController({ mode, switchSide }), switchSide };
}

describe('createController', () => {
  it('starts with an empty scrollback in the given mode', () => {
    const { controller } = controllerIn('plan');
    expect(controller.getSnapshot()).toEqual({ messages: [], mode: 'plan' });
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
