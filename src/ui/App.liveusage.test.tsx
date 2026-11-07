import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, Usage } from '../types.js';
import type { LiveUsage } from '../agent/liveusage.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// The status chips during a request (#925), through the real App: the clock tick, the edges and the
// sum with the session totals all live there, and a render of Status alone sees none of them.

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
  cwd: '/tmp/app-liveusage-test',
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
  onLiveUsage: (live: LiveUsage | undefined) => void;
  onUsage: (u: Usage) => void;
};
let turn: Turn | undefined;
let finishTurn: (e?: Error) => void = () => {};
vi.mock('../agent/loop.js', () => ({
  runTurn: (opts: Turn) =>
    new Promise<void>((resolve, reject) => {
      opts.onMessage({ role: 'user', content: opts.userInput });
      turn = opts;
      finishTurn = e => (e ? reject(e) : resolve());
    }),
}));

const { App } = await import('./App.js');

const plain = (frame: string | undefined) =>
  (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');
const wait = (ms = 25): Promise<void> => new Promise(r => setTimeout(r, ms));

async function busyApp() {
  turn = undefined;
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

async function waitFor(app: Awaited<ReturnType<typeof busyApp>>, text: string, ms = 3000) {
  for (let t = 0; t < ms && !plain(app.lastFrame()).includes(text); t += 25) await wait();
  expect(plain(app.lastFrame())).toContain(text);
}

describe('live status chips (#925)', { timeout: 30_000 }, () => {
  afterEach(() => finishTurn());

  it('moves ↑ at send and ↓ and tok/s on the clock tick', async () => {
    const app = await busyApp();
    turn!.onLiveUsage({ promptTokens: 5000, completionTokens: 0 });
    await waitFor(app, '~5.0k↑');
    turn!.onLiveUsage({ promptTokens: 5000, completionTokens: 2000, rate: 42 });
    expect(plain(app.lastFrame())).not.toContain('42 tok/s');
    await waitFor(app, '~2.0k↓');
    await waitFor(app, '42 tok/s');
    app.unmount();
  });

  it('swaps the estimate for the real count without counting the round twice', async () => {
    const app = await busyApp();
    turn!.onLiveUsage({ promptTokens: 5000, completionTokens: 2000, rate: 42 });
    await waitFor(app, '~5.0k↑');
    const before = app.frames.length;
    turn!.onLiveUsage(undefined);
    turn!.onUsage({ promptTokens: 6000, completionTokens: 3000 });
    await waitFor(app, '6.0k↑ 3.0k↓');
    expect(app.frames.slice(before).filter(f => !plain(f).includes('↑'))).toEqual([]);
    expect(plain(app.lastFrame())).not.toContain('~');
    expect(plain(app.lastFrame())).not.toContain('tok/s');
    app.unmount();
  });

  it('drops the estimate when a request dies without reporting', async () => {
    const app = await busyApp();
    turn!.onLiveUsage({ promptTokens: 5000, completionTokens: 2000 });
    await waitFor(app, '~5.0k↑');
    finishTurn(new Error('stream died'));
    await waitFor(app, 'stream died');
    await wait(50);
    expect(plain(app.lastFrame())).not.toContain('5.0k↑');
    app.unmount();
  });
});
