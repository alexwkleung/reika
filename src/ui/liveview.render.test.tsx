import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { createController, emptyLive, type Controller } from '../controller.js';
import type { Session, SubmitOptions } from '../session.js';
import type { Config, Message } from '../types.js';
import {
  STREAM_FLUSH_MS,
  TYPECHECK_LINGER_MS,
  crossesTurnEdge,
  sameView,
  showsEstimateAtOnce,
  startsToolBlock,
  textToShow,
  toolToShow,
  useLiveView,
  viewForLiveChange,
  type LiveViewHandle,
} from './liveview.js';

describe('liveview rules', () => {
  it('shows a continuation on the flush, and a clear or a reset at once', () => {
    expect(textToShow('ab', 'abcd')).toBe('ab');
    expect(textToShow('', 'abcd')).toBe('');
    expect(textToShow('abcd', '')).toBe('');
    expect(textToShow('abcd', 'xy')).toBe('xy');
  });

  it('replaces a tool block under another name at once, and waits on a first one', () => {
    const bash = { name: 'bash', output: 'a' };
    expect(toolToShow(bash, { name: 'bash', output: 'ab' })).toBe(bash);
    expect(toolToShow(bash, { name: 'grep', output: 'x' })).toEqual({ name: 'grep', output: 'x' });
    expect(toolToShow(bash, null)).toBeNull();
    expect(toolToShow(null, bash)).toBeNull();
    expect(toolToShow(bash, { name: 'bash', output: 'z' })).toEqual({ name: 'bash', output: 'z' });
  });

  it('counts a block the controller started as output', () => {
    const bash = { name: 'bash', output: 'a' };
    expect(startsToolBlock(null, bash)).toBe(true);
    expect(startsToolBlock({ name: 'grep', output: 'x' }, bash)).toBe(true);
    expect(startsToolBlock(bash, { name: 'bash', output: 'ab' })).toBe(false);
    expect(startsToolBlock(bash, null)).toBe(false);
  });

  it('finds the turn edges in the phase', () => {
    expect(crossesTurnEdge(null, 'thinking')).toBe(true);
    expect(crossesTurnEdge('tool', null)).toBe(true);
    expect(crossesTurnEdge('thinking', 'tool')).toBe(false);
    expect(crossesTurnEdge(null, null)).toBe(false);
  });

  it('shows only a round’s first estimate at once', () => {
    const est = { promptTokens: 5, completionTokens: 0 };
    expect(showsEstimateAtOnce(null, est)).toBe(true);
    expect(showsEstimateAtOnce(est, { ...est, completionTokens: 3 })).toBe(false);
    expect(showsEstimateAtOnce(est, null)).toBe(false);
  });

  it('takes every other field from the controller, and the running call unmasked', () => {
    const { usage: _u, ...shown } = { ...emptyLive(), content: 'ab' };
    const running = { name: 'bash', since: 1, call: 1 };
    const next = { ...emptyLive(), content: 'abcd', subagent: true, typechecking: true };
    const view = viewForLiveChange(shown, next, running, false);
    expect(view).toMatchObject({ content: 'ab', subagent: true, typechecking: false });
    expect(view.pending).toBe(running);
    expect('usage' in view).toBe(false);
    expect(sameView(view, { ...view })).toBe(true);
    expect(sameView(view, { ...view, content: 'abcd' })).toBe(false);
  });
});

// A controller on a fake session whose turn stays open until `end` is called.
function liveController() {
  const cfg = {
    autoApprove: 'off',
    models: ['local'],
    profiles: { default: { model: 'local', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' } },
  } as unknown as Config;
  let opts: SubmitOptions | undefined;
  let end: () => void = () => {};
  const session = {
    profile: 'default',
    bundle: { cwd: '/repo/app', skills: [], fileIndex: [] },
    config: cfg,
    shrink: { sheds: 0, folds: 0 },
    lists: { agent: [], plan: [], chat: [], minimal: [], grind: [] },
    getSnapshot: () => ({ config: cfg }),
    subscribe: () => () => {},
    submit: (_text: string, o: SubmitOptions) =>
      new Promise<Message[]>(resolve => {
        opts = o;
        o.onTurnStart?.();
        end = () => {
          o.onTurnEnd?.();
          resolve([]);
        };
      }),
    updateBundle: () => {},
    switchSide: () => {},
    loadHistory: () => {},
    reset: () => {},
    mcp: { call: () => {}, commands: [], list: () => '' },
  };
  const controller = createController({ mode: 'agent', remember: () => {} });
  controller.attachSession(session as unknown as Session, 'default');
  controller.setStatus('idle');
  void controller.runTurn('x', {}, {});
  return {
    controller,
    ev: () => opts!.events!,
    turnOpts: () => opts!,
    end: () => end(),
  };
}

async function mount(controller: Controller) {
  const renders: LiveViewHandle[] = [];
  let latest: LiveViewHandle | undefined;
  function Probe() {
    const handle = useLiveView(controller);
    latest = handle;
    renders.push(handle);
    return <Text>{handle.view.content}</Text>;
  }
  const app = render(<Probe />);
  // The subscription is a passive effect.
  await vi.advanceTimersByTimeAsync(0);
  return { app, renders, now: () => latest! };
}

describe('useLiveView', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('publishes streamed text once per flush window, and a live change mid-window without it', async () => {
    const { controller, ev } = liveController();
    const { app, renders, now } = await mount(controller);
    await vi.advanceTimersByTimeAsync(0);
    const before = renders.length;
    ev().onContentDelta!('a');
    ev().onContentDelta!('b');
    ev().onSubagent!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(now().view).toMatchObject({ subagent: true, content: '' });
    ev().onContentDelta!('c');
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS);
    expect(now().view.content).toBe('abc');
    // The subagent change and one flush.
    expect(renders.length - before).toBe(2);
    app.unmount();
  });

  it('publishes a clear at once', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    ev().onReasoningDelta!('thinking');
    ev().onContentDelta!('reply');
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS);
    expect(now().view).toMatchObject({ content: 'reply', reasoning: 'thinking' });
    ev().onMessage!({ role: 'assistant', content: 'reply' });
    expect(now().view).toMatchObject({ content: '', reasoning: '' });
    app.unmount();
  });

  it('does not render for a live change that moves only throttled fields', async () => {
    const { controller, ev } = liveController();
    const { app, renders } = await mount(controller);
    await vi.advanceTimersByTimeAsync(0);
    const before = renders.length;
    ev().onLiveUsage!({ promptTokens: 5, completionTokens: 0 });
    const afterFirst = renders.length;
    ev().onLiveUsage!({ promptTokens: 5, completionTokens: 1 });
    ev().onLiveUsage!({ promptTokens: 5, completionTokens: 2 });
    expect(afterFirst - before).toBe(1);
    expect(renders.length).toBe(afterFirst);
    app.unmount();
  });

  it('starts a fresh tool block at once when another tool’s output arrives', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    ev().onToolProgress!('a', 'bash');
    expect(now().view.tool).toBeNull();
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MS);
    expect(now().view.tool).toEqual({ name: 'bash', output: 'a' });
    ev().onToolProgress!('b', 'grep');
    expect(now().view.tool).toEqual({ name: 'grep', output: 'b' });
    app.unmount();
  });

  it('stamps streamed output, a first tool chunk included', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    expect(now().lastOutputAtRef.current).toBe(0);
    ev().onToolProgress!('a', 'bash');
    expect(now().lastOutputAtRef.current).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(500);
    ev().onToolProgress!('b', 'bash');
    expect(now().lastOutputAtRef.current).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(500);
    ev().onContentDelta!('c');
    expect(now().lastOutputAtRef.current).toBe(Date.now());
    app.unmount();
  });

  it('pairs the first estimate with the total at once, takes later ones on the tick, and drops it at the end', async () => {
    const { controller, ev, end } = liveController();
    const { app, now } = await mount(controller);
    ev().onLiveUsage!({ promptTokens: 5000, completionTokens: 0 });
    expect(now().usage).toEqual({
      usage: { promptTokens: 5000, completionTokens: 0 },
      base: controller.getSnapshot().usage,
    });
    ev().onLiveUsage!({ promptTokens: 5000, completionTokens: 200 });
    expect(now().usage?.usage.completionTokens).toBe(0);
    now().tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(now().usage?.usage.completionTokens).toBe(200);
    // A clear waits for the tick (or the real count's new total).
    ev().onLiveUsage!(undefined);
    expect(now().usage).not.toBeNull();
    now().tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(now().usage).toBeNull();
    ev().onLiveUsage!({ promptTokens: 6000, completionTokens: 0 });
    expect(now().usage?.usage.promptTokens).toBe(6000);
    end();
    await vi.advanceTimersByTimeAsync(0);
    expect(now().usage).toBeNull();
    app.unmount();
  });

  it('shows a check at once and lingers once it settles', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    ev().onTypecheck!(true);
    expect(now().view.typechecking).toBe(true);
    ev().onTypecheck!(false);
    await vi.advanceTimersByTimeAsync(TYPECHECK_LINGER_MS - 1);
    expect(now().view.typechecking).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(now().view.typechecking).toBe(false);
    app.unmount();
  });

  it('keeps back-to-back checks continuous', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    ev().onTypecheck!(true);
    ev().onTypecheck!(false);
    await vi.advanceTimersByTimeAsync(TYPECHECK_LINGER_MS - 100);
    ev().onTypecheck!(true);
    await vi.advanceTimersByTimeAsync(TYPECHECK_LINGER_MS * 2);
    expect(now().view.typechecking).toBe(true);
    app.unmount();
  });

  it('ends the linger for a prefill worth naming, and keeps it for one that is not (#914)', async () => {
    const { controller, ev } = liveController();
    const { app, now } = await mount(controller);
    ev().onTypecheck!(true);
    ev().onTypecheck!(false);
    ev().onPromptProgress!({ total: 20000, cached: 19900, processed: 19900, elapsedMs: 0 });
    expect(now().view.typechecking).toBe(true);
    ev().onPromptProgress!({ total: 20000, cached: 0, processed: 0, elapsedMs: 0 });
    expect(now().view.typechecking).toBe(false);
    // A check still running keeps its label.
    ev().onTypecheck!(true);
    ev().onPromptProgress!({ total: 20000, cached: 0, processed: 10, elapsedMs: 0 });
    expect(now().view.typechecking).toBe(true);
    app.unmount();
  });

  it('clears a lingering check un-lingered at the turn’s end', async () => {
    const { controller, ev, end } = liveController();
    const { app, now } = await mount(controller);
    ev().onTypecheck!(true);
    ev().onTypecheck!(false);
    end();
    expect(now().view.typechecking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    app.unmount();
  });

  it('clears its timers on unmount', async () => {
    const { controller, ev } = liveController();
    const { app } = await mount(controller);
    ev().onContentDelta!('a');
    ev().onTypecheck!(true);
    ev().onTypecheck!(false);
    expect(vi.getTimerCount()).toBe(2);
    app.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the running call unmasked while an approval is open', async () => {
    const { controller, ev, turnOpts } = liveController();
    const { app, now } = await mount(controller);
    ev().onToolStart!('bash');
    void turnOpts().requestApproval!({ tool: 'bash', subject: 'Run', preview: 'ls' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.live.pending).toBeNull();
    expect(now().view.pending).toMatchObject({ name: 'bash', call: 1 });
    controller.answerApproval(true);
    app.unmount();
  });
});
