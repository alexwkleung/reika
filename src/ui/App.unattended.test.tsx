import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ApprovalRequest, Config, ContextBundle, Tool } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// REIKA_UNATTENDED (#526): a flagged command must decline rather than open a dialog nobody will
// answer, and ask_user must not be offered at all. Driven through the real App because both are
// wiring — which requestApproval the turn gets, which tool list the session builds.

const CONFIG: Config = {
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
  model: 'test-model',
  models: ['test-model'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'safe',
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
  cwd: '/tmp/app-unattended-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => ({ ...CONFIG }) };
});
vi.mock('../context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

type TurnOpts = {
  onMessage: (m: unknown) => void;
  userInput: string;
  tools: Tool[];
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
};

// The turn asks for approval of a flagged command, as bash would, and records the answer.
const answers: boolean[] = [];
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  const ok = await opts.requestApproval!({
    tool: 'bash',
    subject: '/repo',
    preview: 'npm install left-pad',
    warnings: ['installs a package'],
  });
  answers.push(ok);
});
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

type Harness = { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined };

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && plain(app.lastFrame()).includes('Loading…'); i++) await tick(25);
  if (plain(app.lastFrame()).includes('Loading…')) throw new Error('App never finished loading');
  return app;
}

async function submit(app: Harness, text: string) {
  for (let i = 0; i < 200 && !plain(app.lastFrame()).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  app.stdin.write('\r');
  for (let i = 0; i < 120 && runTurn.mock.calls.length === 0; i++) await tick(25);
  await tick(120);
}

const toolNames = () => (runTurn.mock.calls[0][0] as TurnOpts).tools.map(t => t.name);

describe('REIKA_UNATTENDED (#526)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    answers.length = 0;
    CONFIG.unattended = undefined;
  });

  it('declines a flagged command without opening the dialog, and drops ask_user', async () => {
    CONFIG.unattended = true;
    const app = await mountApp();
    expect(plain(app.lastFrame())).toContain('unattended');
    await submit(app, 'set up the project');
    expect(answers).toEqual([false]);
    expect(plain(app.lastFrame())).not.toContain('Bash  /repo');
    expect(toolNames()).not.toContain('ask_user');
    app.unmount();
  });

  it('attended, the same request waits on the dialog and ask_user is offered', async () => {
    const app = await mountApp();
    await submit(app, 'set up the project');
    expect(plain(app.lastFrame())).toContain('Bash  /repo');
    expect(answers).toEqual([]);
    expect(toolNames()).toContain('ask_user');
    app.unmount();
  });
});
