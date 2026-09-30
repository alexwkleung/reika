import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// /implement's mode picker (#561): from plan mode it asks which mode carries the plan out. Driven
// through the real App for the same reason as the skill confirm — where the dialog opens relative
// to the busy queue, and what the replay carries, is submit-path plumbing.

const REVIEW_BODY = 'run `gh pr view` and read the diff';

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
  cwd: '/tmp/app-implementpick-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [
    {
      name: 'review',
      description: 'read a GitHub pull request with gh, then review the diff',
      body: REVIEW_BODY,
      source: 'project',
      path: '/repo/.reika/skills/review.md',
      triggers: ['review pr', 'pull request'],
    },
  ],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG };
});
vi.mock('../context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({ mode: 'plan' }), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

// Each turn hangs until the test settles it, so the busy queue can be exercised.
const settlers: Array<() => void> = [];
const runTurn = vi.fn(
  (opts: { onMessage: (m: unknown) => void; userInput: string }) =>
    new Promise<void>(resolve => {
      opts.onMessage({ role: 'user', content: opts.userInput });
      settlers.push(resolve);
    }),
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
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

async function type(app: Harness, text: string) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
}

async function submit(app: Harness, text: string) {
  await type(app, text);
  app.stdin.write('\r');
  await tick(120);
}

async function waitFor(app: Harness, re: RegExp, ms = 3000) {
  for (let i = 0; i < ms / 25 && !re.test(plain(app.lastFrame())); i++) await tick(25);
  expect(plain(app.lastFrame())).toMatch(re);
}

const DIALOG = /• Implement\s+which mode/;
type TurnOpts = {
  userInput: string;
  promptMode: string;
  minimalPrompt: boolean;
  grindPrompt: boolean;
};
const turn = (n: number) => runTurn.mock.calls[n][0] as unknown as TurnOpts;

describe('/implement mode picker (#561)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    settlers.length = 0;
  });

  it('asks from plan mode, with agent preselected, and Enter implements in agent', async () => {
    const app = await mountApp();
    await submit(app, '/implement');
    await waitFor(app, DIALOG);
    const frame = plain(app.lastFrame());
    expect(frame).toMatch(/› 1\. Agent/);
    expect(frame).toContain('2. Minimal');
    expect(frame).toContain('3. Grind');
    // A pick among peers has no "yes", so the footer offers no y/n.
    expect(frame).toContain('1-3 navigate');
    expect(frame).not.toContain('y/n jump');
    // The command's autocomplete row does not linger under the dialog.
    expect(frame).not.toContain('tab/enter accept');
    expect(runTurn).not.toHaveBeenCalled();

    app.stdin.write('\r');
    await waitFor(app, /Agent mode — implementing the plan above/);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(turn(0).promptMode).toBe('agent');
    expect(turn(0).grindPrompt).toBe(false);
    expect(turn(0).minimalPrompt).toBe(false);
    app.unmount();
  });

  it('implements in grind when picked, and stays in grind afterwards', async () => {
    const app = await mountApp();
    await submit(app, '/implement keep it small');
    await waitFor(app, DIALOG);
    app.stdin.write('3');
    await waitFor(app, /› 3\. Grind/);
    expect(runTurn).not.toHaveBeenCalled();
    app.stdin.write('\r');
    await waitFor(app, /Grind mode — implementing the plan above/);
    expect(turn(0).grindPrompt).toBe(true);
    expect(turn(0).userInput).toContain('Additional guidance: keep it small');
    settlers.shift()?.();
    await tick(120);
    // The next prompt runs in the mode the plan was handed to.
    await submit(app, 'and the tests');
    await waitFor(app, /▎ and the tests/);
    expect(turn(1).grindPrompt).toBe(true);
    app.unmount();
  });

  it('implements in minimal when picked with the arrow keys', async () => {
    const app = await mountApp();
    await submit(app, '/implement');
    await waitFor(app, DIALOG);
    app.stdin.write('\x1b[B');
    await waitFor(app, /› 2\. Minimal/);
    app.stdin.write('\r');
    await waitFor(app, /Minimal mode — implementing the plan above/);
    expect(turn(0).minimalPrompt).toBe(true);
    app.unmount();
  });

  it('ctrl-c runs nothing and leaves the command in the box', async () => {
    const app = await mountApp();
    await submit(app, '/implement');
    await waitFor(app, DIALOG);
    app.stdin.write('\x03');
    await tick(120);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(inputLine(app)).toContain('/implement');
    expect(runTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  it('esc cancels like ctrl-c', async () => {
    const app = await mountApp();
    await submit(app, '/implement');
    await waitFor(app, DIALOG);
    expect(plain(app.lastFrame())).toContain('esc/ctrl-c abort');
    app.stdin.write('\x1b');
    await tick(200);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(inputLine(app)).toContain('/implement');
    expect(runTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  it('asks a /implement queued behind a running turn at keypress, and the replay does not ask again', async () => {
    const app = await mountApp();
    await submit(app, 'plan the change');
    await waitFor(app, /▎ plan the change/);
    expect(runTurn).toHaveBeenCalledTimes(1);

    await submit(app, '/implement');
    await waitFor(app, DIALOG);
    app.stdin.write('3');
    await waitFor(app, /› 3\. Grind/);
    app.stdin.write('\r');
    await waitFor(app, /\[Queued\] \/implement/);

    settlers.shift()?.();
    await waitFor(app, /Grind mode — implementing the plan above/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turn(1).grindPrompt).toBe(true);
    app.unmount();
  });
});
