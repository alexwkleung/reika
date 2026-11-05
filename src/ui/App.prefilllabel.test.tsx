import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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

const { App, TYPECHECK_LINGER_MS } = await import('./App.js');

const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));

const LONG = { total: 20000, cached: 0, processed: 0, elapsedMs: 0 };
const SHORT = { total: 20000, cached: 19900, processed: 19900, elapsedMs: 0 };

// A write can beat the input's stdin listener, so keep typing until the text echoes.
async function busyApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await wait();
  for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('hello'); i++) {
    app.stdin.write('hello');
    await wait();
  }
  app.stdin.write('\r');
  for (let i = 0; i < 400 && !turn; i++) await wait();
  if (!turn) throw new Error('the turn never started');
  return app;
}

async function waitFor(app: Awaited<ReturnType<typeof busyApp>>, text: string) {
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes(text); i++) await wait();
  expect(plain(app.lastFrame())).toContain(text);
}

// Asserted on the timer rather than the frame, so a slow runner passing 650ms cannot decide it.
function lingerTimer(setTimeoutSpy: MockInstance<typeof setTimeout>) {
  const at = setTimeoutSpy.mock.calls.findIndex(call => call[1] === TYPECHECK_LINGER_MS);
  expect(at).toBeGreaterThanOrEqual(0);
  return setTimeoutSpy.mock.results[at].value as NodeJS.Timeout;
}

describe('prefill label handoff (#914)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    turn = undefined;
    runTurn.mockClear();
  });
  afterEach(() => {
    finishTurn();
    vi.restoreAllMocks();
  });

  it("ends a finished check's linger", async () => {
    const app = await busyApp();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    turn!.onTypecheck!(true);
    turn!.onTypecheck!(false);
    const timer = lingerTimer(setSpy);
    turn!.onPromptProgress!(LONG);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    await waitFor(app, 'Processing context 0%');
    expect(plain(app.lastFrame())).not.toContain('Typechecking');
    app.unmount();
  });

  it('leaves a running check its label', async () => {
    const app = await busyApp();
    turn!.onTypecheck!(true);
    turn!.onPromptProgress!(LONG);
    await waitFor(app, 'Typechecking');
    expect(plain(app.lastFrame())).not.toContain('Processing context');
    turn!.onTypecheck!(false);
    app.unmount();
  });

  it('keeps the linger for a round too short to name', async () => {
    const app = await busyApp();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    turn!.onTypecheck!(true);
    turn!.onTypecheck!(false);
    const timer = lingerTimer(setSpy);
    turn!.onPromptProgress!(SHORT);
    expect(clearSpy).not.toHaveBeenCalledWith(timer);
    app.unmount();
  });
});
