import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ApprovalAnswer, ApprovalRequest, Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import { frameRise } from './framedrops.js';
import { createSyncedStdout } from './syncframe.js';

// Answering a bash approval closed a 13-row dialog in one frame, and the input box jumped up by all
// of it until the command's output streamed back in. The answer now holds those rows until the
// call's result commits. Driven through the real App at a pinned size, reading Ink's bytes.

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

const APPROVAL: ApprovalRequest = {
  tool: 'bash',
  subject: 'Run a command',
  preview: 'pnpm install',
  warnings: ['Package install (runs third-party install scripts)'],
};
const OUTPUT = Array.from({ length: 10 }, (_, i) => `progress line ${i}`);

type TurnOpts = {
  onMessage: (m: unknown) => void;
  onToolStart?: (name: string) => void;
  onToolProgress?: (chunk: string, tool: string) => void;
  userInput: string;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
};
// The test opens each gate when it has read the frames of the phase before it.
const gates: (() => void)[] = [];
const gate = (): Promise<void> => new Promise(r => gates.push(r));
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onToolStart?.('bash');
  await opts.requestApproval!(APPROVAL);
  await gate();
  for (const line of OUTPUT) opts.onToolProgress?.(line + '\n', 'bash');
  await gate();
  opts.onMessage({
    role: 'tool',
    callId: 'c1',
    summary: 'Ran: pnpm install',
    command: { text: 'pnpm install', outputTail: OUTPUT.join('\n'), outputTruncated: false },
  });
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

const maxRise = (frames: string[]): number => Math.max(0, ...frames.map(f => frameRise(f) ?? 0));
const dialogRows = (frame: string): number =>
  plain(frame)
    .split('\n')
    .filter(l => /Approve|Decline|pnpm install|Run a command|─/.test(l)).length;

describe('answering an approval holds the input (#897)', () => {
  it('keeps the dialog rows until the result commits', async () => {
    const out = new Out();
    const stdin = new In();
    Object.defineProperty(process.stdout, 'columns', { value: out.columns, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: out.rows, configurable: true });
    // Through the same per-tick batching the CLI renders through, so each write is one frame the
    // terminal paints: unbatched, a commit's erase and its reprint arrive as separate writes.
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
    for (let i = 0; i < 200 && !last().includes('run it'); i++) {
      stdin.write('run it');
      await tick(20);
    }
    stdin.write('\r');
    for (let i = 0; i < 200 && !last().includes('Decline, and say'); i++) await tick(20);
    // A dialog tall enough that a drop would show.
    expect(dialogRows(out.writes.at(-1) ?? '')).toBeGreaterThan(5);

    let mark = out.writes.length;
    stdin.write('\r');
    for (let i = 0; i < 100 && !last().includes('Running'); i++) await tick(20);
    await tick(200);
    expect(last()).not.toContain('Decline, and say');
    expect(maxRise(out.writes.slice(mark)), 'the answer').toBe(0);

    mark = out.writes.length;
    gates.shift()!();
    for (let i = 0; i < 100 && !last().includes('progress line 9'); i++) await tick(20);
    await tick(200);
    expect(maxRise(out.writes.slice(mark)), 'output streaming in').toBe(0);

    mark = out.writes.length;
    gates.shift()!();
    for (let i = 0; i < 200 && !last().includes('Ran: pnpm install'); i++) await tick(20);
    for (let i = 0; i < 200 && out.writes.length > 0 && /Running/.test(last()); i++) await tick(20);
    await tick(200);
    // The committed chip takes back about what the stream held; a row or two is the chip's own
    // shape (its `$ command` row), not the dialog's height.
    expect(maxRise(out.writes.slice(mark)), 'the commit').toBeLessThanOrEqual(2);
    // Released: nothing is left holding blank rows over the input once the call is done.
    expect(last()).not.toMatch(/\n(\s*\n){4,}/);
    app.unmount();
  }, 30_000);
});
