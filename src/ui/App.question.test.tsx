import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, QuestionAnswer, QuestionRequest, Tool } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// The ask_user dialog's keyboard wiring (#651): ctrl-c is the only way out of the free-text field,
// and it has to put the option list back rather than drop the question. Driven through the real App
// because the whole point is which useInput branch sees the keypress.

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
  cwd: '/tmp/app-question-test',
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

const REQUEST: QuestionRequest = {
  question: 'Flag every interpreter, or only inline bodies?',
  options: [{ label: 'Flag only inline bodies' }, { label: 'Flag every interpreter invocation' }],
};

type TurnOpts = {
  onMessage: (m: unknown) => void;
  userInput: string;
  tools: Tool[];
  requestQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer | null>;
};

// The turn asks one question, as ask_user would, and waits on the answer.
const answers: (QuestionAnswer | null)[] = [];
// Set by a test that needs the turn running, question not yet asked (a draft typed mid-turn).
let gate: Promise<void> | null = null;
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  if (gate) await gate;
  answers.push(await opts.requestQuestion!(REQUEST));
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

// Unannotated return: the harness only needs stdin/lastFrame, but the tests unmount the app.
async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

async function ask(app: Harness): Promise<void> {
  for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('ask me'); i++) {
    app.stdin.write('ask me');
    await tick(20);
  }
  await press(app, '\r');
  await until(app, 'Flag only inline bodies', 'the question dialog');
}

describe('ask_user dialog: backing out of the answer field (#651)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    answers.length = 0;
    gate = null;
  });

  it('ctrl-c on the own-answer field returns to the options, and ctrl-c there aborts', async () => {
    const app = await mountApp();
    await ask(app);

    // The last row is the type-your-own one; a digit moves the cursor without submitting.
    await press(app, '3', '› 3. Something else', 'the own-answer row selected');
    await press(app, '\r', 'Type your answer below.', 'the answer field');
    expect(plain(app.lastFrame())).toContain('ctrl-c back to the options');
    await press(app, 'my own', 'my own', 'the typed draft');

    // Back to the list — the question is still open, so nothing has been answered.
    await press(app, CTRL_C, 'Flag every interpreter invocation', 'the option list');
    expect(plain(app.lastFrame())).not.toContain('Type your answer below.');
    expect(answers).toEqual([]);
    // Backing out discards the typed answer: left in the box, it would outlive the question.
    expect(plain(app.lastFrame())).not.toContain('my own');

    // From the list, ctrl-c is still the abort.
    await press(app, CTRL_C);
    for (let i = 0; i < 100 && answers.length === 0; i++) await tick(20);
    expect(answers).toEqual([null]);
    expect(plain(app.lastFrame())).not.toContain('Flag only inline bodies');
    app.unmount();
  });

  it('a note being added backs out the same way, and the list still answers', async () => {
    const app = await mountApp();
    await ask(app);

    await press(app, '\t', 'Adding a note to: Flag only inline bodies', 'the note field');
    await press(app, 'wait', 'wait', 'the typed note');
    await press(app, CTRL_C, 'Flag only inline bodies', 'the option list');
    expect(answers).toEqual([]);

    // Still live: picking an option from the restored list answers the question as usual.
    await press(app, '2', '› 2. Flag every interpreter invocation', 'option 2 selected');
    await press(app, '\r');
    for (let i = 0; i < 100 && answers.length === 0; i++) await tick(20);
    expect(answers).toEqual([{ text: 'Flag every interpreter invocation', index: 1 }]);
    // The abandoned note is gone, so it can't be queued as the next prompt once the box is live.
    expect(plain(app.lastFrame())).not.toContain('wait');
    app.unmount();
  });

  it('backing out restores a draft that was in the box before the field opened', async () => {
    let release!: () => void;
    gate = new Promise(r => (release = r));
    const app = await mountApp();
    for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('ask me'); i++) {
      app.stdin.write('ask me');
      await tick(20);
    }
    await press(app, '\r');
    // Mid-turn the box is live: the user starts their next prompt before the question arrives.
    await press(app, 'next', 'next', 'the mid-turn draft');
    release();
    await until(app, 'Flag only inline bodies', 'the question dialog');

    // The field opens on the draft, as it always has; only what is typed in it is discarded.
    await press(app, '\t', 'Adding a note to: Flag only inline bodies', 'the note field');
    await press(app, ' note', 'next note', 'the typed note');
    await press(app, CTRL_C, 'Flag every interpreter invocation', 'the option list');
    expect(plain(app.lastFrame())).toContain('next');
    expect(plain(app.lastFrame())).not.toContain('next note');
    expect(answers).toEqual([]);
    app.unmount();
  });

  it('submitting the own answer still resolves with the typed text', async () => {
    const app = await mountApp();
    await ask(app);

    await press(app, '3', '› 3. Something else', 'the own-answer row selected');
    await press(app, '\r', 'Type your answer below.', 'the answer field');
    await press(app, 'both', 'both', 'the typed answer');
    await press(app, '\r');
    for (let i = 0; i < 100 && answers.length === 0; i++) await tick(20);
    expect(answers).toEqual([{ text: 'both' }]);
    app.unmount();
  });
});
