import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Config, ContextBundle, QuestionAnswer, QuestionRequest } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import { frameRise } from './framedrops.js';
import { createSyncedStdout } from './syncframe.js';

// Answering an ask_user question closed its dialog in one frame and the input jumped up by its
// height, then the answer row and the model's next thinking pushed it back down. The answer now
// holds the dialog's rows, gives back what each commit adds above them, and lets the next round's
// stream fill them. Driven through the real App at a pinned size, reading Ink's bytes.

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
  cwd: '/tmp/app-dialogframe-test',
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

const QUESTION: QuestionRequest = {
  question: 'Which package manager should this repository use?',
  options: [
    { label: 'pnpm', description: 'the lockfile is pnpm-lock.yaml' },
    { label: 'npm', description: 'only if the lockfile switches over' },
  ],
};
const THINKING = Array.from({ length: 12 }, (_, i) => `thinking about step ${i}.`);

type TurnOpts = {
  onMessage: (m: unknown) => void;
  onToolStart?: (name: string) => void;
  onReasoningDelta?: (delta: string) => void;
  userInput: string;
  requestQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer | null>;
};
const gates: (() => void)[] = [];
const gate = (): Promise<void> => new Promise(r => gates.push(r));
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onToolStart?.('ask_user');
  const answer = await opts.requestQuestion!(QUESTION);
  opts.onMessage({
    role: 'tool',
    callId: 'q1',
    summary: `Asked the user — answered: ${answer?.text}`,
  });
  // The next round's prefill: nothing streams until the test opens the gate.
  await gate();
  for (const line of THINKING) {
    opts.onReasoningDelta?.(line + '\n');
    await new Promise(r => setTimeout(r, 30));
  }
  await gate();
});
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

// Ink stops erasing the live frame when CI is set (is-in-ci, read once at import), so every rise
// would read 0. Cleared before Ink loads, as App.dialogframe.test.tsx does.
const ciEnv = process.env.CI;
process.env.CI = 'false';
const { render: inkRender } = await import('ink');
const { App } = await import('./App.js');
const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
afterAll(() => {
  if (ciEnv === undefined) delete process.env.CI;
  else process.env.CI = ciEnv;
  for (const [key, desc] of [
    ['columns', stdoutColumns],
    ['rows', stdoutRows],
  ] as const) {
    if (desc) Object.defineProperty(process.stdout, key, desc);
    else delete (process.stdout as unknown as Record<string, unknown>)[key];
  }
});

class Out extends EventEmitter {
  writes: string[] = [];
  columns = 100;
  rows = 40;
  isTTY = true;
  write = (frame: string): boolean => {
    this.writes.push(frame);
    return true;
  };
}
class In extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

const rise = (w: string): number => frameRise(w) ?? 0;
// The other direction: rows the input moved down, a frame that printed more than it erased.
const fall = (w: string): number => {
  const up = w.split('\x1b[1A').length - 1;
  const down = w.split('\n').length - 1;
  return Math.max(0, down - up);
};
const max = (frames: string[], f: (w: string) => number): number => Math.max(0, ...frames.map(f));

async function answerQuestion() {
  const out = new Out();
  const stdin = new In();
  Object.defineProperty(process.stdout, 'columns', { value: out.columns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: out.rows, configurable: true });
  const app = inkRender(<App />, {
    stdout: createSyncedStdout(out as never, {}),
    stdin: stdin as never,
    stderr: new Out() as never,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const last = (): string => plain(out.writes.at(-1) ?? '');
  for (let i = 0; i < 400 && !last().includes('╭'); i++) await tick(25);
  for (let i = 0; i < 200 && !last().includes('ask me'); i++) {
    stdin.write('ask me');
    await tick(20);
  }
  stdin.write('\r');
  for (let i = 0; i < 200 && !last().includes('Something else'); i++) await tick(20);
  const mark = out.writes.length;
  stdin.write('\r');
  for (
    let i = 0;
    i < 100 && !plain(out.writes.slice(mark).join('')).includes('answered: pnpm');
    i++
  )
    await tick(20);
  await tick(60);
  return { app, out, last, mark };
}

describe('answering a question holds the input', () => {
  it('neither jumps up at the answer nor drops down when the answer row commits', async () => {
    const { app, out, last, mark } = await answerQuestion();
    const frames = out.writes.slice(mark);
    expect(plain(frames.join(''))).toContain('answered: pnpm');
    expect(max(frames, rise), 'up').toBe(0);
    expect(max(frames, fall), 'down').toBe(0);
    // The next round's thinking streams into the held rows rather than below them.
    const streamed = out.writes.length;
    gates.shift()!();
    for (let i = 0; i < 100 && !last().includes('step 5'); i++) await tick(20);
    expect(max(out.writes.slice(streamed), rise), 'thinking, up').toBe(0);
    expect(max(out.writes.slice(streamed), fall), 'thinking, down').toBe(0);
    for (let i = 0; i < 100 && gates.length === 0; i++) await tick(20);
    gates.shift()!();
    await tick(200);
    app.unmount();
  }, 30_000);

  it('eases the blank out over a long prefill', async () => {
    const { app, out, mark } = await answerQuestion();
    await tick(1000);
    const frames = out.writes.slice(mark);
    const total = frames.reduce((n, w) => n + rise(w), 0);
    expect(total, 'the space slid away').toBeGreaterThan(5);
    expect(max(frames, rise), 'a slide, not a snap').toBeLessThanOrEqual(Math.ceil(total * 0.4));
    gates.shift()!();
    for (let i = 0; i < 100 && gates.length === 0; i++) await tick(20);
    gates.shift()!();
    await tick(200);
    app.unmount();
  }, 30_000);
});
