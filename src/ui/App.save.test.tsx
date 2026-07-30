import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, Message } from '../types.js';
import type { TranscriptMeta } from '../store/transcript.js';
import type * as ConfigModule from '../config.js';
import type * as TranscriptModule from '../store/transcript.js';

// /save is the only consumer of the per-turn mode stamp (#118), and the stamp is applied in App
// where the loop's user message is handed to the scrollback. These tests mount the real App,
// drive real turns through a stubbed loop, and assert on what /save was actually handed —
// nothing else in the UI renders the mode, so this wiring has no other witness.

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
  pasteFetch: false,
  skillAuto: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-save-test',
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
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

// A turn that settles immediately, emitting only the prompt echo the real loop emits first —
// enough for the mode stamp, and it leaves the app idle so the next command can be typed.
type TurnOpts = { userInput: string; onMessage: (m: Message) => void };
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
});
vi.mock('../agent/loop.js', () => ({
  runTurn: (...a: unknown[]) => runTurn(...(a as [TurnOpts])),
}));

// The write itself is transcript.ts's job (covered there); here we only need what App passes in.
type SaveArgs = Parameters<typeof TranscriptModule.saveTranscript>;
const saveTranscript = vi.fn<typeof TranscriptModule.saveTranscript>();
saveTranscript.mockResolvedValue({ jsonlPath: '/h/x.jsonl', txtPath: '/h/x.txt' });
vi.mock('../store/transcript.js', async () => {
  const actual = await vi.importActual<typeof TranscriptModule>('../store/transcript.js');
  return { ...actual, saveTranscript: (...a: unknown[]) => saveTranscript(...(a as SaveArgs)) };
});

const { App } = await import('./App.js');

const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 40 && plain(app.lastFrame()).includes('Loading…'); i++) await tick(25);
  return app;
}

/** Type a line and submit it, then let the resulting turn/command settle. */
async function submit(app: { stdin: { write: (s: string) => void } }, text: string) {
  app.stdin.write(text);
  await tick();
  app.stdin.write('\r');
  await tick(120);
}

/** The (messages, meta) /save was called with. */
function savedWith(): { messages: Message[]; meta: TranscriptMeta } {
  const args = saveTranscript.mock.calls.at(-1);
  if (!args) throw new Error('/save never reached saveTranscript');
  return { messages: args[1], meta: args[2] };
}

describe('/save records the mode', () => {
  beforeEach(() => {
    runTurn.mockClear();
    saveTranscript.mockClear();
  });

  it('stamps each turn with the mode it ran in and reports the save-time mode', async () => {
    const app = await mountApp();
    await submit(app, 'fix the parser');
    await submit(app, '/plan');
    await submit(app, 'plan the rewrite');
    await submit(app, '/save');

    const { messages, meta } = savedWith();
    expect(meta.mode).toBe('plan');
    const turns = messages.filter(m => m.role === 'user' && !m.meta);
    expect(turns.map(m => (m as { mode?: string }).mode)).toEqual(['agent', 'plan']);
    app.unmount();
  });

  it('leaves the command echoes unstamped — they sit between turns, not in one', async () => {
    const app = await mountApp();
    await submit(app, '/plan');
    await submit(app, '/save');

    const { messages } = savedWith();
    const echo = messages.find(m => m.role === 'user' && m.content === '/plan');
    expect(echo).toBeDefined();
    expect((echo as { mode?: string }).mode).toBeUndefined();
    app.unmount();
  });

  it('records a vibe turn as vibe, not as its internal plan and agent phases', async () => {
    const app = await mountApp();
    await submit(app, '/vibe');
    await submit(app, 'ship it');
    await submit(app, '/save');

    const { messages } = savedWith();
    const turns = messages.filter(m => m.role === 'user' && !m.meta);
    // The plan phase produced no plan (the stubbed loop writes none), so the chain stops there:
    // one recorded turn, and it says vibe rather than plan.
    expect(turns.map(m => (m as { mode?: string }).mode)).toEqual(['vibe']);
    app.unmount();
  });
});
