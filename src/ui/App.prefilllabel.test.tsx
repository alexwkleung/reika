import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, PromptProgress } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// The prefill label against the typecheck linger (#914), through the real App: both are label state
// in App's own chain, and a test of Working alone cannot see which one wins.

const CONFIG: Config = {
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
  model: 'test-model',
  models: ['test-model'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'off',
  subagentMaxTurns: 5,
  profiles: {
    default: { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' },
  },
  minGenTokens: 512,
  reasoningRounds: 1,
  maxSearchesPerTurn: 3,
  maxFetchesPerTurn: 3,
  bashTimeoutMs: 1000,
  bashIdleMs: 1000,
  pasteFetch: 'off',
  skillAuto: 'ask',
  anon: false,
  sandbox: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-prefilllabel-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG };
});
vi.mock('../context/bootstrap.js', async importActual => ({
  ...(await importActual<object>()),
  bootstrap: async () => BUNDLE,
}));
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

type Turn = {
  onMessage: (m: unknown) => void;
  userInput: string;
  onTypecheck?: (checking: boolean) => void;
  onPromptProgress?: (p: PromptProgress | undefined) => void;
};
let turn: Turn | undefined;
let finishTurn: () => void = () => {};
const runTurn = vi.fn(
  (opts: Turn) =>
    new Promise<void>(resolve => {
      opts.onMessage({ role: 'user', content: opts.userInput });
      turn = opts;
      finishTurn = resolve;
    }),
);
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

const { App } = await import('./App.js');

const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

const LONG = { total: 20000, cached: 0, processed: 0, elapsedMs: 0 };
const SHORT = { total: 20000, cached: 19900, processed: 19900, elapsedMs: 0 };

async function busyApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await wait(25);
  app.stdin.write('hello');
  await wait(120);
  app.stdin.write('\r');
  for (let i = 0; i < 200 && !turn; i++) await wait(25);
  return app;
}

describe('prefill label handoff (#914)', () => {
  beforeEach(() => {
    turn = undefined;
    runTurn.mockClear();
  });
  afterEach(() => finishTurn());

  it("ends a finished check's linger", async () => {
    const app = await busyApp();
    turn!.onTypecheck!(true);
    await wait();
    turn!.onTypecheck!(false);
    await wait();
    expect(plain(app.lastFrame())).toContain('Typechecking');
    turn!.onPromptProgress!(LONG);
    await wait();
    expect(plain(app.lastFrame())).toContain('Processing context 0%');
    expect(plain(app.lastFrame())).not.toContain('Typechecking');
    app.unmount();
  });

  it('leaves a running check its label', async () => {
    const app = await busyApp();
    turn!.onTypecheck!(true);
    turn!.onPromptProgress!(LONG);
    await wait();
    expect(plain(app.lastFrame())).toContain('Typechecking');
    turn!.onTypecheck!(false);
    app.unmount();
  });

  it('keeps the linger for a round too short to name', async () => {
    const app = await busyApp();
    turn!.onTypecheck!(true);
    turn!.onTypecheck!(false);
    turn!.onPromptProgress!(SHORT);
    await wait();
    expect(plain(app.lastFrame())).toContain('Typechecking');
    app.unmount();
  });
});
