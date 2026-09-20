import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// The skill confirm (#425): under REIKA_SKILL_AUTO a command-shaped match asks before submit
// instead of injecting. Driven through the real App because the whole feature is submit-path
// plumbing — where the dialog opens relative to the busy queue and the expansions, what the
// replay carries — and a unit test on the dialog component sees none of it.

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
  pasteFetch: false,
  skillAuto: 'ask',
  anon: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-skillconfirm-test',
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
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
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
  for (let i = 0; i < 400 && plain(app.lastFrame()).includes('Loading…'); i++) await tick(25);
  if (plain(app.lastFrame()).includes('Loading…')) throw new Error('App never finished loading');
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

const DIALOG = /⏺︎ Skill\s+\/review/;
const turnInput = (n: number) => (runTurn.mock.calls[n][0] as { userInput: string }).userInput;
const turnSkill = (n: number) => (runTurn.mock.calls[n][0] as { userSkill?: string }).userSkill;

describe('skill confirm (#425)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    settlers.length = 0;
    CONFIG.skillAuto = 'ask';
  });

  it("still asks under 'apply' — a human present is never a reason to inject silently", async () => {
    CONFIG.skillAuto = 'apply';
    const app = await mountApp();
    await submit(app, 'review pr 420');
    await waitFor(app, DIALOG);
    expect(runTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  it("only hints under 'off'", async () => {
    CONFIG.skillAuto = 'off';
    const app = await mountApp();
    await submit(app, 'review pr 420');
    await waitFor(app, /Skill hint: \/review/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(turnInput(0)).toBe('review pr 420');
    app.unmount();
  });

  it('asks on a command-shaped match and sends the prompt as typed on Enter', async () => {
    const app = await mountApp();
    await submit(app, 'review pr 420');
    await waitFor(app, DIALOG);
    const frame = plain(app.lastFrame());
    expect(frame).toMatch(/› 1\. Send as typed/);
    expect(frame).toContain('2. Apply /review');
    // The prompt is still in the box underneath while the dialog is up (the disabled input shows
    // `…` for its prompt, so look at the row after the dialog's footer rather than at `> `).
    const rows = frame.split('\n');
    const footer = rows.findIndex(r => r.includes('ctrl-c abort'));
    expect(rows.slice(footer).some(r => r.includes('…') && r.includes('review pr 420'))).toBe(true);
    expect(runTurn).not.toHaveBeenCalled();

    app.stdin.write('\r');
    await waitFor(app, /▎ review pr 420/);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(turnInput(0)).toBe('review pr 420');
    expect(turnSkill(0)).toBeUndefined();
    // The dialog replaced the hint: no "start with /review" line after an explicit decline.
    expect(plain(app.lastFrame())).not.toContain('Skill hint');
    app.unmount();
  });

  it('applies the skill on y + Enter, with the receipt', async () => {
    const app = await mountApp();
    await submit(app, 'review pr 420');
    await waitFor(app, DIALOG);
    app.stdin.write('y');
    await waitFor(app, /› 2\. Apply \/review/);
    // y only moved the cursor; nothing ran yet.
    expect(runTurn).not.toHaveBeenCalled();
    app.stdin.write('\r');
    await waitFor(app, /Skill \/review applied/);
    expect(turnInput(0)).toBe(`${REVIEW_BODY}\n\nreview pr 420`);
    expect(turnSkill(0)).toBe('review');
    app.unmount();
  });

  it('asks about a long-tail command the silent gate would only suggest', async () => {
    const app = await mountApp();
    await submit(
      app,
      'review pr 420 but first explain how the compaction note is fitted into the recap and why',
    );
    await waitFor(app, DIALOG);
    app.unmount();
  });

  it('does not ask about a prompt that merely mentions the nouns — the hint fires instead', async () => {
    const app = await mountApp();
    await submit(app, 'add a pull request template to the repo');
    await waitFor(app, /Skill hint: \/review/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(turnInput(0)).toBe('add a pull request template to the repo');
    app.unmount();
  });

  it('ctrl-c drops the submit and leaves the prompt in the box', async () => {
    const app = await mountApp();
    await submit(app, 'review pr 420');
    await waitFor(app, DIALOG);
    app.stdin.write('\x03');
    await tick(120);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(inputLine(app)).toContain('review pr 420');
    expect(runTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  it('asks at keypress while busy and the queued entry carries the answer to the replay', async () => {
    const app = await mountApp();
    await submit(app, 'hi');
    expect(runTurn).toHaveBeenCalledTimes(1);
    await submit(app, 'review pr 420');
    await waitFor(app, DIALOG);
    app.stdin.write('y');
    await waitFor(app, /› 2\. Apply \/review/);
    app.stdin.write('\r');
    await waitFor(app, /next › review pr 420/);
    expect(runTurn).toHaveBeenCalledTimes(1);

    settlers[0]();
    await waitFor(app, /Skill \/review applied/);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turnInput(1)).toBe(`${REVIEW_BODY}\n\nreview pr 420`);
    expect(turnSkill(1)).toBe('review');
    app.unmount();
  });
});
