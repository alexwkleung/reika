import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, Message } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// The model-facing history is a separate array from the scrollback (#183): the loop folds spans of
// it into a `compaction` recap, and that fold must SURVIVE to the next turn. Seeding each turn from
// the React `messages` state (the old `.slice()`) silently undid every fold, so the work was redone
// and the recap — which lives in the system block — was rewritten every turn, invalidating the
// server's prompt prefix from token 0. Nothing else in the UI witnesses this wiring, so these tests
// mount the real App and drive real turns through a stubbed loop that folds like the real one.

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
  cwd: '/tmp/app-history-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG, resolveDefaultMode: () => 'agent' };
});

vi.mock('../context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));

// The real module reads and writes ~/.config/reika/state.json (#365); the test must neither start
// in whoever ran it last's mode nor leave its own behind.
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

type TurnOpts = {
  userInput: string;
  history: Message[];
  promptMode?: string;
  onMessage: (m: Message) => void;
};

// Snapshot of the history each turn was handed, taken before the turn mutates it.
const seen: Message[][] = [];
// Set to fold the NEXT turn's history the way compactHistory does: replace everything after the
// pinned first user message with one recap, in place.
let foldNextTurn = false;

// Mirrors the real loop's contract: it pushes each committed message onto `opts.history` AND emits
// it to the UI, and it may rewrite older history in place.
const runTurn = vi.fn(async (opts: TurnOpts) => {
  seen.push(opts.history.slice());
  const user: Message = { role: 'user', content: opts.userInput };
  opts.history.push(user);
  opts.onMessage(user);
  const reply: Message =
    opts.promptMode === 'plan'
      ? { role: 'assistant', content: '1. edit a.ts', planFinal: true }
      : { role: 'assistant', content: 'done' };
  opts.history.push(reply);
  opts.onMessage(reply);
  if (foldNextTurn) {
    foldNextTurn = false;
    opts.history.splice(1, opts.history.length - 1, { role: 'compaction', content: 'RECAP' });
  }
});
vi.mock('../agent/loop.js', () => ({
  runTurn: (...a: unknown[]) => runTurn(...(a as [TurnOpts])),
}));

const { App } = await import('./App.js');

const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

// See App.save.test.tsx: the input row only, and the write is retried until it echoes.
function inputLine(app: { lastFrame: () => string | undefined }): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

async function submit(
  app: { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined },
  text: string,
) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
  app.stdin.write('\r');
  await tick(120);
}

describe('model-facing history persists across turns', () => {
  beforeEach(() => {
    runTurn.mockClear();
    seen.length = 0;
    foldNextTurn = false;
  });

  it('carries a compaction fold into the next turn instead of re-expanding it', async () => {
    const app = await mountApp();
    await submit(app, 'first');
    foldNextTurn = true;
    await submit(app, 'second');
    await submit(app, 'third');

    expect(seen).toHaveLength(3);
    // Turn 3 is handed the FOLDED history: the recap, plus only what turn 2 left after it.
    const third = seen[2];
    expect(third.filter(m => m.role === 'compaction')).toHaveLength(1);
    expect(third.some(m => m.role === 'user' && m.content === 'second')).toBe(false);
    expect(third[0]).toMatchObject({ role: 'user', content: 'first' });
    app.unmount();
  });

  it('keeps the folded messages in the scrollback — the fold is model-facing only', async () => {
    const app = await mountApp();
    await submit(app, 'first');
    foldNextTurn = true;
    await submit(app, 'second');

    const frame = plain(app.lastFrame());
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).not.toContain('RECAP');
    app.unmount();
  });

  it('keeps UI-only scrollback (command echoes, notices) out of the model history', async () => {
    const app = await mountApp();
    await submit(app, 'first');
    await submit(app, '/plan');
    await submit(app, 'second');

    // Two turns ran; the second was handed exactly the first turn's two messages.
    expect(seen).toHaveLength(2);
    expect(seen[1].map(m => m.role)).toEqual(['user', 'assistant']);
    app.unmount();
  });

  it('/new resets the model history, not just the scrollback', async () => {
    const app = await mountApp();
    await submit(app, 'first');
    await submit(app, '/new');
    await submit(app, 'second');

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
    app.unmount();
  });

  it('hands vibe’s implement phase the plan its plan phase just wrote', async () => {
    const app = await mountApp();
    await submit(app, '/vibe');
    await submit(app, 'ship it');

    // Phase 1 (plan) then phase 2 (implement) — the second sees phase 1's plan message.
    expect(seen).toHaveLength(2);
    expect(seen[1].some(m => m.role === 'assistant' && m.planFinal)).toBe(true);
    app.unmount();
  });
});
