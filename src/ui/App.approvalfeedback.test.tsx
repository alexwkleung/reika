import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ApprovalAnswer, ApprovalRequest, Config, ContextBundle, Tool } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// Declining with a reason: the last approval row opens the input box as the field, Enter sends the
// reason, an empty Enter sends nothing, and ctrl-c backs out to the options without deciding.
// Driven through the real App because the point is which useInput branch sees each keypress.

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
  cwd: '/tmp/app-approvalfeedback-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => ({ ...CONFIG }) };
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

const REQUEST: ApprovalRequest = { tool: 'bash', subject: 'npm test', preview: 'npm test' };

type TurnOpts = {
  onMessage: (m: unknown) => void;
  userInput: string;
  tools: Tool[];
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
};

const answers: ApprovalAnswer[] = [];
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  answers.push(await opts.requestApproval!(REQUEST));
});
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

type Harness = { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined };

async function until(app: Harness, want: string, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (plain(app.lastFrame()).includes(want)) return;
    await tick(20);
  }
  throw new Error(`never saw ${what} (${JSON.stringify(want)}):\n${plain(app.lastFrame())}`);
}

// One keystroke per write: Ink parses a coalesced chunk as a single, multi-character keypress.
async function press(app: Harness, key: string, want?: string, what = ''): Promise<void> {
  app.stdin.write(key);
  await tick();
  if (want) await until(app, want, what || want);
}

const CTRL_C = '\x03';
const DOWN = '\x1b[B';

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

async function openApproval(app: Harness): Promise<void> {
  for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('run it'); i++) {
    app.stdin.write('run it');
    await tick(20);
  }
  await press(app, '\r');
  await until(app, 'Decline, and say what to do instead', 'the approval dialog');
}

async function openField(app: Harness): Promise<void> {
  for (let i = 0; i < 3; i++) await press(app, DOWN);
  await until(app, '› Decline, and say what to do instead', 'the feedback row selected');
  await press(app, '\r', 'type what to do instead below', 'the reason field');
}

describe('approval: decline with a reason', () => {
  beforeEach(() => {
    runTurn.mockClear();
    answers.length = 0;
  });

  it('sends the typed reason, and an empty Enter sends nothing', async () => {
    const app = await mountApp();
    await openApproval(app);
    await openField(app);
    expect(plain(app.lastFrame())).toContain('ctrl-c back to the options');

    await press(app, '\r');
    expect(answers).toEqual([]);
    expect(plain(app.lastFrame())).toContain('type what to do instead below');

    await press(app, 'use pnpm', 'use pnpm', 'the typed reason');
    await press(app, '\r');
    for (let i = 0; i < 100 && answers.length === 0; i++) await tick(20);
    expect(answers).toEqual([{ feedback: 'use pnpm' }]);
    expect(plain(app.lastFrame())).not.toContain('Decline, and say what to do instead');
    app.unmount();
  });

  it('ctrl-c in the field backs out to the options, and the options still answer', async () => {
    const app = await mountApp();
    await openApproval(app);
    await openField(app);
    await press(app, 'never mind', 'never mind', 'the typed reason');

    await press(app, CTRL_C, '› Decline, and say what to do instead', 'the option list');
    expect(answers).toEqual([]);
    expect(plain(app.lastFrame())).not.toContain('never mind');

    await press(app, 'n');
    for (let i = 0; i < 100 && answers.length === 0; i++) await tick(20);
    expect(answers).toEqual([false]);
    app.unmount();
  });
});
