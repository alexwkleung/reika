import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import { tmpdir } from 'node:os';

// Shell-mode runs reach the model with the next prompt. Driven through the real App with a real
// command, since what matters is the path from the shell submit to the turn's input.

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
  skillAuto: 'off',
  anon: false,
  sandbox: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
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

const runTurn = vi.fn(
  (opts?: { onMessage: (m: unknown) => void; userInput: string; userDisplay?: string }) => {
    opts?.onMessage({ role: 'user', content: opts.userInput, display: opts.userDisplay });
    return Promise.resolve();
  },
);
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

type Harness = { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined };

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

function inputLine(app: Harness): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && /[>$?] /.test(l));
  return rows[rows.length - 1] ?? '';
}

async function submit(app: Harness, text: string) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
  app.stdin.write('\r');
  await tick(150);
}

async function waitFor(app: Harness, text: string) {
  for (let i = 0; i < 120 && !plain(app.lastFrame()).includes(text); i++) await tick(25);
  expect(plain(app.lastFrame())).toContain(text);
}

async function waitForTurns(n: number) {
  for (let i = 0; i < 120 && turns().length < n; i++) await tick(25);
  expect(turns()).toHaveLength(n);
}

// Turns only: the session also calls runTurn with no options, which the counts must skip.
const turns = () => runTurn.mock.calls.filter(c => c[0] !== undefined);
const turnInput = (n: number) => (turns()[n][0] as { userInput: string }).userInput;

describe('shell-mode runs reach the model', () => {
  beforeEach(() => runTurn.mockClear());

  it('prepends the run to the next prompt, once', async () => {
    const app = await mountApp();
    await submit(app, '/shell');
    await waitFor(app, 'Shell mode');
    await submit(app, 'echo shellmarker; exit 3');
    await waitFor(app, 'shellmarker');
    await submit(app, '/agent');
    await submit(app, 'why did that fail');
    await waitForTurns(1);
    const input = turnInput(0);
    expect(input).toContain('<shell-runs>');
    expect(input).toContain('$ echo shellmarker; exit 3  (exit 3)\nshellmarker');
    expect(input.endsWith('why did that fail')).toBe(true);
    // The bubble is the user's own words.
    expect(plain(app.lastFrame())).not.toContain('<shell-runs>');

    await submit(app, 'and now');
    await waitForTurns(2);
    expect(turnInput(1)).toBe('and now');
  });

  it('holds runs across a chat detour and drops them on /new', { timeout: 15_000 }, async () => {
    const app = await mountApp();
    await submit(app, '/shell');
    await waitFor(app, 'Shell mode');
    await submit(app, 'echo detourmarker');
    await waitFor(app, 'detourmarker');
    await submit(app, '/chat');
    await submit(app, 'hello chat');
    await waitForTurns(1);
    expect(turnInput(0)).toBe('hello chat');
    await submit(app, '/agent');
    await submit(app, 'back');
    await waitForTurns(2);
    expect(turnInput(1)).toContain('detourmarker');

    await submit(app, '/shell');
    await submit(app, 'echo gonemarker');
    await waitFor(app, 'gonemarker');
    await submit(app, '/new');
    await submit(app, 'fresh');
    await waitForTurns(3);
    expect(turnInput(2)).toBe('fresh');
  });
});
