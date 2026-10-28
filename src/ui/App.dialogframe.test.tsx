import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  Config,
  ContextBundle,
  QuestionAnswer,
  QuestionRequest,
  Tool,
} from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// #842: on a narrow pane an approval popup came up with the frame at the viewport's height, and
// Ink's answer to a frame that tall is a full repaint — `\x1b[2J\x1b[3J\x1b[H`, which clears the
// native scrollback (iTerm2's "a control sequence attempted to clear scrollback history"). The
// dialogs sized their previews against fixed row counts, so the wraps a narrow width adds to the
// dialog's OWN rows (subject, warnings, option labels, hint) were spent out of the viewport.
//
// Driven through the real App at a pinned terminal size, reading the bytes Ink actually writes:
// a render test of the dialog alone cannot see the input box and the status bar underneath it,
// which is where the last rows of the budget go.

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

// A command long enough that the preview would happily fill the viewport, and a warning, so the
// dialog is showing everything it can — the shape that reached the viewport height.
const PREVIEW = Array.from({ length: 80 }, (_, i) => `echo step-${i} && pnpm test`).join('\n');
const APPROVAL: ApprovalRequest = {
  tool: 'bash',
  subject: '~/some/deep/project/directory/name',
  preview: PREVIEW,
  warnings: ['Remote package execution (npx/bunx/uvx)'],
};
// ask_user's dialog has the other shape: every word in it is model-written and wraps.
const QUESTION: QuestionRequest = {
  question: 'Which package manager should this repository use, and why?',
  options: [
    { label: 'pnpm, since the lockfile is pnpm-lock.yaml and CI installs with it' },
    { label: 'npm', description: 'only if you intend to switch the lockfile over' },
  ],
};

type TurnOpts = {
  onMessage: (m: unknown) => void;
  userInput: string;
  tools: Tool[];
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  requestQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer | null>;
};
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  if (questionTurn) answers.push(await opts.requestQuestion!(QUESTION));
  else await opts.requestApproval!(APPROVAL);
});
// Which dialog the mocked turn opens, set by the test that is driving the app.
let questionTurn = false;
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
afterAll(() => {
  if (ciEnv === undefined) delete process.env.CI;
  else process.env.CI = ciEnv;
});

// Both dialogs' answers: the mocked turn records whichever one it opened.
const answers: (ApprovalAnswer | QuestionAnswer | null)[] = [];

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

async function openDialog(cols: number, rows: number, want: string) {
  const out = new Out();
  out.columns = cols;
  out.rows = rows;
  const stdin = new In();
  // The App sizes its own packing off process.stdout, so both have to agree with the stream.
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
  for (let i = 0; i < 200 && !plain(last()).includes('run it'); i++) {
    stdin.write('run it');
    await tick(20);
  }
  stdin.write('\r');
  for (let i = 0; i < 200 && !plain(last()).includes(want); i++) await tick(20);
  return { app, out };
}

describe('a dialog on a narrow pane stays under the viewport (#842)', () => {
  it('never asks Ink to repaint the whole terminal', async () => {
    for (const [cols, rows] of [
      [100, 40],
      [60, 40],
      [50, 40],
      [40, 40],
      [40, 30],
      [40, 24],
    ]) {
      const { app, out } = await openDialog(cols, rows, 'Decline, and say');
      // The frame the dialog is in, as the terminal received it: `outputHeight >= rows` makes Ink
      // write `clearTerminal` first, and that is the scrollback wipe the issue reports.
      expect(out.writes.at(-1) ?? '', `${cols}x${rows}`).not.toContain(CLEAR);
      expect(plain(out.writes.at(-1) ?? '')).toContain('Decline, and say');
      app.unmount();
    }
  }, 60_000);

  it('holds for ask_user too', async () => {
    questionTurn = true;
    try {
      // Panes where the question dialog's options fit. Narrower than this the options alone need
      // more rows than the pane has (every option always shows), so no budget can save it.
      for (const [cols, rows] of [
        [100, 40],
        [60, 40],
        [50, 40],
        [40, 40],
        [40, 30],
      ]) {
        const { app, out } = await openDialog(cols, rows, 'Something else');
        expect(out.writes.at(-1) ?? '', `${cols}x${rows}`).not.toContain(CLEAR);
        expect(plain(out.writes.at(-1) ?? '')).toContain('Something else');
        app.unmount();
      }
    } finally {
      questionTurn = false;
    }
  }, 60_000);

  // The instrument above has to be able to see the bug it is guarding against: a pane with no room
  // for the dialog at all still makes Ink repaint, and this test would be vacuous if it didn't.
  it('sees the repaint on a pane with no room for anything', async () => {
    const { app, out } = await openDialog(40, 8, 'Decline, and say');
    expect(out.writes.at(-1) ?? '').toContain(CLEAR);
    app.unmount();
  }, 30_000);
});
