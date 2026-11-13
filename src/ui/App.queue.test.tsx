import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// Prompts queued behind a running turn, replayed through the real App. A pasted image leaves the
// live ref with its entry and has to be back on it at replay, or the model gets a bare marker; and
// a second entry must wait for the first replay, which is idle while its input is built.

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
  pasteFetch: 'ask',
  skillAuto: 'off',
  anon: false,
  sandbox: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-queue-test',
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

vi.mock('./clipboard.js', () => ({
  clipboardImageSupported: () => true,
  readClipboardImage: async () => Buffer.from('png'),
}));
vi.mock('../ocr/select.js', () => ({
  imageReader: () => async () => ({ ok: true, text: 'TEXT READ FROM THE SCREENSHOT' }),
  pasteIsNative: () => false,
}));

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

const turnInput = (n: number) => (runTurn.mock.calls[n][0] as { userInput: string }).userInput;
const CTRL_V = '\x16';

describe('prompts queued behind a running turn', () => {
  beforeEach(() => {
    runTurn.mockClear();
    settlers.length = 0;
  });

  it('replays a pasted image with its image block', async () => {
    const app = await mountApp();
    await submit(app, 'hi');
    expect(runTurn).toHaveBeenCalledTimes(1);

    app.stdin.write(CTRL_V);
    await waitFor(app, /Attached \[Image 1\]/);
    await submit(app, 'what is this');
    await waitFor(app, /next › \[Image 1\] what is this \[image\]/);
    expect(runTurn).toHaveBeenCalledTimes(1);

    settlers[0]();
    for (let i = 0; i < 120 && runTurn.mock.calls.length < 2; i++) await tick(25);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turnInput(1)).toContain('<image');
    expect(turnInput(1)).toContain('TEXT READ FROM THE SCREENSHOT');
    expect(turnInput(1)).toContain('what is this');
    expect(turnInput(1).split('[Image 1]')).toHaveLength(2);
    app.unmount();
  });

  it('does not queue an image whose marker was deleted before Enter', async () => {
    const app = await mountApp();
    await submit(app, 'hi');
    app.stdin.write(CTRL_V);
    await waitFor(app, /Attached \[Image 1\]/);
    for (let i = 0; i < 40 && inputLine(app).includes('['); i++) {
      app.stdin.write('\x7f');
      await tick(20);
    }
    expect(inputLine(app)).not.toContain('[');
    await submit(app, 'never mind the picture');
    await waitFor(app, /next › never mind the picture(?! \[image\])/);

    settlers[0]();
    for (let i = 0; i < 120 && runTurn.mock.calls.length < 2; i++) await tick(25);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turnInput(1)).toContain('never mind the picture');
    expect(turnInput(1)).not.toContain('<image');
    app.unmount();
  });

  it('replays every queued prompt in order, the image only on its own', async () => {
    const app = await mountApp();
    await submit(app, 'hi');
    app.stdin.write(CTRL_V);
    await waitFor(app, /Attached \[Image 1\]/);
    await submit(app, 'what is this');
    await submit(app, 'and a plain one');
    await waitFor(app, /then › and a plain one/);

    settlers[0]();
    for (let i = 0; i < 120 && runTurn.mock.calls.length < 2; i++) await tick(25);
    settlers[1]();
    for (let i = 0; i < 120 && runTurn.mock.calls.length < 3; i++) await tick(25);
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(turnInput(1)).toContain('what is this');
    expect(turnInput(2)).toContain('and a plain one');
    expect(turnInput(2)).not.toContain('<image');
    app.unmount();
  });
});
