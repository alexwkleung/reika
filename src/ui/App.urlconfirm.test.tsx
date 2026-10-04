import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import type * as FetchModule from '../tools/fetch.js';
import type { ExtractOptions, UrlExtraction } from '../tools/fetch.js';

// The pasted-link confirm (#448): a URL the prompt is not about is asked about before submit
// instead of fetched. Driven through the real App like the skill confirm's tests, since what
// matters is where the dialog sits in the submit path — before the fetch, before the queue —
// and what the answer does to the turn's input.

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
  cwd: '/tmp/app-urlconfirm-test',
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

const extractUrl = vi.hoisted(() =>
  vi.fn<(url: string, opts?: ExtractOptions) => Promise<UrlExtraction>>(),
);
// Only the fetch is stubbed; the tool and the recap's page parser stay real (App imports both).
vi.mock('../tools/fetch.js', async () => {
  const actual = await vi.importActual<typeof FetchModule>('../tools/fetch.js');
  return { ...actual, extractUrl };
});

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

const DIALOG = /• Pasted link/;
const INCIDENTAL = 'TypeError: fetch failed at https://api.example.com/v1/users why';
const turnInput = (n: number) => (runTurn.mock.calls[n][0] as { userInput: string }).userInput;

describe('pasted-link confirm (#448)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    settlers.length = 0;
    extractUrl.mockReset();
    extractUrl.mockImplementation(async (url: string) => ({
      ok: true,
      content: `page at ${url}`,
      extractedChars: 12,
    }));
    CONFIG.pasteFetch = 'ask';
  });

  it('fetches a link the prompt is about without asking', async () => {
    const app = await mountApp();
    await submit(app, 'read https://example.com/docs');
    await waitFor(app, /Fetched https:\/\/example\.com\/docs/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(extractUrl).toHaveBeenCalledWith('https://example.com/docs', { allowPrivate: true });
    expect(turnInput(0)).toContain('<url href="https://example.com/docs">');
    app.unmount();
  });

  it('asks about a link inside an error and sends the prompt as typed on Enter', async () => {
    const app = await mountApp();
    await submit(app, INCIDENTAL);
    await waitFor(app, DIALOG);
    const frame = plain(app.lastFrame());
    expect(frame).toContain('https://api.example.com/v1/users');
    expect(frame).toMatch(/› 1\. Send as typed/);
    expect(frame).toContain('2. Fetch the link');
    expect(extractUrl).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();

    app.stdin.write('\r');
    await waitFor(app, /▎ TypeError: fetch failed/);
    expect(extractUrl).not.toHaveBeenCalled();
    expect(turnInput(0)).toBe(INCIDENTAL);
    // A decline needs no receipt: the dialog was the line.
    expect(plain(app.lastFrame())).not.toContain('not fetched');
    app.unmount();
  });

  it('fetches on y + Enter, with the host policy opened by the confirmation', async () => {
    const app = await mountApp();
    await submit(app, INCIDENTAL);
    await waitFor(app, DIALOG);
    app.stdin.write('y');
    await waitFor(app, /› 2\. Fetch the link/);
    expect(extractUrl).not.toHaveBeenCalled();
    app.stdin.write('\r');
    await waitFor(app, /Fetched https:\/\/api\.example\.com\/v1\/users/);
    expect(extractUrl).toHaveBeenCalledWith('https://api.example.com/v1/users', {
      allowPrivate: true,
    });
    expect(turnInput(0)).toContain('<url href="https://api.example.com/v1/users">');
    expect(turnInput(0)).toContain(INCIDENTAL);
    app.unmount();
  });

  it("still asks under 'apply' — a human present is never a reason to fetch silently", async () => {
    CONFIG.pasteFetch = 'apply';
    const app = await mountApp();
    await submit(app, INCIDENTAL);
    await waitFor(app, DIALOG);
    expect(extractUrl).not.toHaveBeenCalled();
    app.unmount();
  });

  it("neither asks nor fetches under 'off'", async () => {
    CONFIG.pasteFetch = 'off';
    const app = await mountApp();
    await submit(app, 'read https://example.com/docs');
    await waitFor(app, /▎ read https:\/\/example\.com\/docs/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(extractUrl).not.toHaveBeenCalled();
    expect(turnInput(0)).toBe('read https://example.com/docs');
    app.unmount();
  });

  it('refuses a credentialed link outright, and the receipt keeps the secret out', async () => {
    const app = await mountApp();
    await submit(app, 'read https://user:hunter2@example.com/private');
    await waitFor(app, /credentials in it \(example\.com\)/);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(extractUrl).not.toHaveBeenCalled();
    // The prompt itself echoes what the user typed; the receipt must not add a second copy.
    const receipts = plain(app.lastFrame())
      .split('\n')
      .filter(l => l.includes('credentials'));
    expect(receipts.every(l => !l.includes('hunter2'))).toBe(true);
    app.unmount();
  });

  it('ctrl-c drops the submit and leaves the prompt in the box', async () => {
    const app = await mountApp();
    await submit(app, INCIDENTAL);
    await waitFor(app, DIALOG);
    app.stdin.write('\x03');
    await tick(120);
    expect(plain(app.lastFrame())).not.toMatch(DIALOG);
    expect(inputLine(app)).toContain('TypeError');
    expect(runTurn).not.toHaveBeenCalled();
    expect(extractUrl).not.toHaveBeenCalled();
    app.unmount();
  });

  it('asks at keypress while busy and the queued entry carries the answer to the replay', async () => {
    const app = await mountApp();
    await submit(app, 'hi');
    expect(runTurn).toHaveBeenCalledTimes(1);
    await submit(app, INCIDENTAL);
    await waitFor(app, DIALOG);
    app.stdin.write('y');
    await waitFor(app, /› 2\. Fetch the link/);
    app.stdin.write('\r');
    await waitFor(app, /next › TypeError/);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(extractUrl).not.toHaveBeenCalled();

    settlers[0]();
    await waitFor(app, /Fetched https:\/\/api\.example\.com\/v1\/users/);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turnInput(1)).toContain('<url href="https://api.example.com/v1/users">');
    app.unmount();
  });
});
