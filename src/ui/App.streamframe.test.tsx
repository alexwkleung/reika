import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// On a narrow pane (three iTerm2 panes side by side) the status bar wraps onto several rows, and
// the live region was budgeted against a one-row bar. A streaming reply then grew the frame to the
// viewport's height, where Ink repaints the whole terminal on every chunk — `\x1b[3J` clears the
// native scrollback (iTerm2's "a control sequence attempted to clear scrollback history") and
// snaps the view to the top. Driven through the real App at a pinned size, as in
// App.dialogframe.test.tsx, reading the bytes Ink writes.

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
  cwd: '/tmp/app-streamframe-test',
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

const LONG_REPLY = Array.from(
  { length: 120 },
  (_, i) => `Line ${i} of a long streamed answer that wraps on a narrow pane.`,
).join('\n');

type TurnOpts = {
  onMessage: (m: unknown) => void;
  onContentDelta?: (delta: string) => void;
  userInput: string;
};
let release: () => void = () => {};
let streamed = false;
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  for (const line of LONG_REPLY.split('\n')) {
    opts.onContentDelta?.(line + '\n');
    await new Promise(r => setTimeout(r, 2));
  }
  streamed = true;
  // Held open so the frames under test are all mid-stream, with the busy status bar showing.
  await new Promise<void>(r => (release = r));
});
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));
// `is-in-ci` reads the environment once, when Ink is first evaluated, and on a CI runner Ink then
// writes only the committed <Static> rows — the live frame never reaches stdout, so the bytes this
// file is about never arrive and neither the dialog nor the repaint can be seen. The harness needs
// the path a real terminal takes, so CI is cleared BEFORE anything pulls Ink in: a dynamic import
// rather than a static one, since static imports are hoisted above this line, and `vi.mock` on
// `is-in-ci` cannot reach a transitive dependency of an externalized node_modules package.
const ciEnv = process.env.CI;
process.env.CI = 'false';
const { render: inkRender } = await import('ink');
const { App } = await import('./App.js');
// openDialog pins process.stdout's size for the App's own packing; put the real one back after.
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

// ink-testing-library's stdout has no `rows`, so Ink never takes its full-repaint branch and the
// clear the issue reports cannot happen in a render test at all. This one writes to a stream with
// both dimensions, which is what Ink reads (`outputHeight >= stdout.rows`).
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
// `ansi-escapes`' clearTerminal, spelled out: it is Ink's dependency, not ours.
const CLEAR = '\x1b[3J';

async function streamAt(cols: number, rows: number) {
  const out = new Out();
  out.columns = cols;
  out.rows = rows;
  const stdin = new In();
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  const app = inkRender(<App />, {
    stdout: out as never,
    stdin: stdin as never,
    stderr: new Out() as never,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const last = (): string => out.writes.at(-1) ?? '';
  for (let i = 0; i < 400 && !plain(last()).includes('╭'); i++) await tick(25);
  for (let i = 0; i < 200 && !plain(last()).includes('go'); i++) {
    stdin.write('go');
    await tick(20);
  }
  const submitted = out.writes.length;
  streamed = false;
  stdin.write('\r');
  for (let i = 0; i < 300 && !streamed; i++) await tick(20);
  await tick(150);
  const cleared = out.writes.slice(submitted).some(w => w.includes(CLEAR));
  release();
  return { app, out, cleared };
}

describe('a streaming reply on a narrow pane stays under the viewport', () => {
  it('budgets the rows a wrapped status bar takes', async () => {
    for (const [cols, rows] of [
      [100, 30],
      [60, 30],
      [45, 30],
      [38, 30],
      [32, 24],
    ]) {
      const { app, out, cleared } = await streamAt(cols, rows);
      expect(cleared, `${cols}x${rows}`).toBe(false);
      // The stream did reach the live region, and the frame holding it fits under the viewport.
      const frame = plain(out.writes.at(-1) ?? '').replace(/\x1b\[(2K|1A|G)/g, '');
      expect(frame, `${cols}x${rows}`).toContain('on a narrow pane.');
      expect(frame.replace(/\n$/, '').split('\n').length, `${cols}x${rows}`).toBeLessThan(rows);
      app.unmount();
    }
  }, 60_000);
});
