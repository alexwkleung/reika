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
// Delay between output lines, for a command that prints one line at a time.
let trickleMs = 0;
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onToolStart?.('bash');
  await opts.requestApproval!(APPROVAL);
  await gate();
  for (const line of OUTPUT) {
    opts.onToolProgress?.(line + '\n', 'bash');
    if (trickleMs) await new Promise(r => setTimeout(r, trickleMs));
  }
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
// The hold's ease is what the bottom floor replaces, so these run on the baseline arm.
process.env.REIKA_INPUT_FLOOR = '0';
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
// Rows between the spinner and the input's top border: the slack goes under the live stream, so
// the spinner stays where it sits on any other frame instead of riding down the held space.
const spinnerGap = (frame: string): number => {
  const lines = plain(frame).split('\n');
  const spinner = lines.findIndex(l => l.includes('Working'));
  const input = lines.findIndex(l => l.startsWith('╭'));
  return spinner === -1 || input === -1 ? 0 : input - spinner;
};
const dialogRows = (frame: string): number =>
  plain(frame)
    .split('\n')
    .filter(l => /Approve|Decline|pnpm install|Run a command|─/.test(l)).length;

// Sends a prompt, waits for the approval dialog and answers it. Each write is one frame the
// terminal paints: rendered through the same per-tick batching the CLI uses, since unbatched a
// commit's erase and its reprint arrive as separate writes.
async function answerApproval() {
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
  for (let i = 0; i < 200 && !last().includes('run it'); i++) {
    stdin.write('run it');
    await tick(20);
  }
  stdin.write('\r');
  for (let i = 0; i < 200 && !last().includes('Decline, and say'); i++) await tick(20);
  // A dialog tall enough that a drop would show.
  expect(dialogRows(out.writes.at(-1) ?? '')).toBeGreaterThan(5);
  const mark = out.writes.length;
  stdin.write('\r');
  // A frame written after the answer: the one before the dialog opened already showed the row.
  for (let i = 0; i < 100 && (out.writes.length === mark || !last().includes('Running')); i++)
    await tick(20);
  expect(last()).not.toContain('Decline, and say');
  // The dialog collapses into the command it cleared, drawn where its chip will commit it.
  expect(last()).toMatch(/↳ Running…\n\n {5}\$ pnpm install\n/);
  // The frame the answer lands in holds: the dialog's rows are kept for the grace window.
  expect(frameRise(out.writes[mark]!) ?? 0, 'the answer').toBe(0);
  return { app, out, last, mark };
}

async function finishCall(out: Out, last: () => string): Promise<number> {
  gates.shift()!();
  for (let i = 0; i < 100 && !last().includes('progress line 9'); i++) await tick(20);
  const mark = out.writes.length;
  gates.shift()!();
  for (let i = 0; i < 200 && /Running/.test(last()); i++) await tick(20);
  await tick(200);
  return mark;
}

// Blank rows between the approved command (or its output) and the spinner.
const blankUnderCommand = (frame: string): number => {
  const lines = plain(frame).split('\n');
  const spinner = lines.findIndex(l => l.includes('Working'));
  let n = 0;
  for (let i = spinner - 1; i >= 0 && lines[i]!.trim() === ''; i--) n++;
  return n;
};

describe('answering an approval holds the input (#897)', () => {
  it('lets output that arrives in the grace window fill the dialog rows', async () => {
    const { app, out, last } = await answerApproval();
    await tick(50);
    let mark = out.writes.length;
    gates.shift()!();
    for (let i = 0; i < 100 && !last().includes('progress line 9'); i++) await tick(20);
    await tick(200);
    expect(maxRise(out.writes.slice(mark)), 'output streaming in').toBe(0);
    for (const w of out.writes.slice(mark)) expect(spinnerGap(w)).toBeLessThanOrEqual(2);

    mark = out.writes.length;
    gates.shift()!();
    for (let i = 0; i < 200 && /Running/.test(last()); i++) await tick(20);
    await tick(200);
    // The committed chip takes back about what the stream held; a row or two is the chip's own
    // shape (its `$ command` row), not the dialog's height.
    expect(maxRise(out.writes.slice(mark)), 'the commit').toBeLessThanOrEqual(2);
    // Released: nothing is left holding blank rows over the input once the call is done.
    expect(last()).not.toMatch(/\n(\s*\n){4,}/);
    // Committed rows keep the App's one-column gutter: <Static> places them by its parent's
    // padding, so the hold must not put a box between them and the root.
    expect(plain(out.writes.join(''))).toMatch(/^ ▎ run it/m);
    app.unmount();
  }, 30_000);

  it('eases the blank out when the command stays silent', async () => {
    const { app, out, last, mark } = await answerApproval();
    const held = blankUnderCommand(out.writes[mark]!);
    expect(held, 'blank the dialog left').toBeGreaterThan(5);
    await tick(1200);
    const silent = out.writes.slice(mark);
    // A slide, not a snap: no frame moves the input by more than a few rows, the frames together
    // take back the whole blank, and none of it is left under the command.
    expect(maxRise(silent), 'one frame of the ease').toBeLessThanOrEqual(Math.ceil(held * 0.35));
    expect(silent.reduce((sum, w) => sum + (frameRise(w) ?? 0), 0)).toBeGreaterThanOrEqual(
      held - 1,
    );
    expect(blankUnderCommand(out.writes.at(-1)!)).toBeLessThanOrEqual(1);
    await finishCall(out, last);
    app.unmount();
  }, 30_000);

  // `for i in …; do echo line $i; sleep 0.5; done`: each line lands after the grace window has
  // passed. Easing between lines slid the input up and then had every line push it back down.
  it('holds for a command that prints one line at a time', async () => {
    trickleMs = 400;
    try {
      const { app, out, last, mark } = await answerApproval();
      gates.shift()!();
      for (let i = 0; i < 300 && !last().includes('progress line 9'); i++) await tick(20);
      expect(maxRise(out.writes.slice(mark)), 'lines arriving one at a time').toBe(0);
      for (let i = 0; i < 100 && gates.length === 0; i++) await tick(20);
      const done = out.writes.length;
      gates.shift()!();
      for (let i = 0; i < 200 && /Running/.test(last()); i++) await tick(20);
      await tick(200);
      expect(maxRise(out.writes.slice(done)), 'the commit').toBeLessThanOrEqual(2);
      app.unmount();
    } finally {
      trickleMs = 0;
    }
  }, 30_000);
});
