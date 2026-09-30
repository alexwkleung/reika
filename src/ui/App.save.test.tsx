import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, Message, Usage } from '../types.js';
import type { TranscriptMeta } from '../store/transcript.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
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

// The real module reads and writes ~/.config/reika/state.json (#365); the test must neither start
// in whoever ran it last's mode nor leave its own behind.
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

// A turn that settles immediately, emitting the prompt echo the real loop emits first, a one-line
// reply (so the turn counts as a turn, as the status line counts them), and one call's usage —
// enough for the mode stamp and the usage block, and it leaves the app idle so the next command
// can be typed.
type TurnOpts = {
  userInput: string;
  onMessage: (m: Message) => void;
  onUsage?: (u: Usage) => void;
};
const CALL_USAGE: Usage = { promptTokens: 1000, completionTokens: 100, cachedTokens: 800 };
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onMessage({ role: 'assistant', content: 'ok' });
  opts.onUsage?.(CALL_USAGE);
});
// A turn that lands one round and then parks until the test releases it — the app stays busy in
// between, which is the state a mid-turn /save has to work in (#226). The reply that follows the
// release is the "round still streaming" a mid-turn save must not contain.
let releaseTurn: (() => void) | null = null;
const runParkedTurn = async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onMessage({ role: 'assistant', content: 'first round' });
  opts.onUsage?.(CALL_USAGE);
  await new Promise<void>(r => (releaseTurn = r));
  opts.onMessage({ role: 'assistant', content: 'second round' });
};
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
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

// The current contents of the input row — the boxed line carrying the '> ' prompt. Scoped to that
// row on purpose: the surrounding scrollback echoes earlier commands, so a whole-frame search would
// report text as "typed" that is really just sitting in history.
function inputLine(app: { lastFrame: () => string | undefined }): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

/** Type a line and submit it, then let the resulting turn/command settle.
 *
 * The write is RETRIED until the input echoes it. Ink's useInput subscription is not live the
 * instant the frame paints, and under full-suite parallel load the first submit's characters were
 * dropped outright — the input still showed its placeholder afterwards and the turn never happened,
 * surfacing downstream as a missing mode stamp. Waiting on the frame's appearance cannot fix that,
 * because the frame already looks idle and ready. Retrying is safe rather than double-typing:
 * `stdin.write` emits one 'data' event, so a dropped write is all-or-nothing and leaves nothing
 * behind to append to. */
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

// The status line's numbers ride along in the saved meta (#199), so a shared transcript carries
// them without the footer pasted next to it. App is the only place that holds all four.
describe('/save records the status-line accounting', () => {
  beforeEach(() => {
    runTurn.mockClear();
    saveTranscript.mockClear();
  });

  it('carries session totals, turn count, current ctx and the last call cache', async () => {
    const app = await mountApp();
    await submit(app, 'fix the parser');
    await submit(app, 'and the lexer');
    await submit(app, '/save');

    const { meta } = savedWith();
    expect(meta.usage).toBeDefined();
    // Two turns, summed across both calls; ctx and cache come from the last call alone.
    expect(meta.usage).toMatchObject({
      turns: 2,
      promptTokens: 2000,
      completionTokens: 200,
      cachedTokens: 1600,
      contextTokens: 1000,
      lastCachedTokens: 800,
    });
    // The stub config declares no window, so the field stays absent rather than guessing one.
    expect(meta.usage?.contextWindow).toBeUndefined();
    expect(meta.usage?.contextEstimated).toBeUndefined();
    app.unmount();
  });

  it('saves zeroed counts before any turn has run', async () => {
    const app = await mountApp();
    await submit(app, '/plan');
    await submit(app, '/save');

    const { meta } = savedWith();
    expect(meta.usage).toMatchObject({ turns: 0, promptTokens: 0, completionTokens: 0 });
    // No call has landed, so whatever context size is recorded is the pre-send estimate.
    expect(meta.usage?.contextEstimated).toBe(true);
    expect(meta.usage?.cachedTokens).toBeUndefined();
    expect(meta.usage?.lastCachedTokens).toBeUndefined();
    app.unmount();
  });
});

// A run that looks wrong is exactly when a transcript is worth handing to another agent, and
// aborting to get one throws away the run. /save is the one command that skips the busy queue.
describe('/save while a turn is in flight (#226)', () => {
  beforeEach(() => {
    runTurn.mockClear();
    saveTranscript.mockClear();
    releaseTurn = null;
  });

  it('saves on the spot, up to the last completed round, and the turn carries on', async () => {
    runTurn.mockImplementationOnce(runParkedTurn);
    const app = await mountApp();
    await submit(app, 'fix the parser');
    for (let i = 0; i < 100 && releaseTurn === null; i++) await tick(20);
    expect(releaseTurn).not.toBeNull();

    await submit(app, '/save');
    // Landed while busy: not queued, and the snapshot stops at the round that had finished.
    expect(saveTranscript).toHaveBeenCalledTimes(1);
    const { messages, meta } = savedWith();
    const replies = messages.filter(m => m.role === 'assistant').map(m => m.content);
    expect(replies).toContain('first round');
    expect(replies).not.toContain('second round');
    expect(meta.midTurn).toBe(true);
    expect(meta.usage).toMatchObject({ turns: 1 });
    expect(plain(app.lastFrame())).toContain('mid-turn');

    releaseTurn!();
    await tick(120);
    // The turn was never interrupted — its remaining round still landed in the scrollback.
    expect(plain(app.lastFrame())).toContain('second round');
    // The busy path did not run the command a second time on drain.
    expect(saveTranscript).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it('honours --raw mid-turn and leaves the marker off a save taken between turns', async () => {
    runTurn.mockImplementationOnce(runParkedTurn);
    const app = await mountApp();
    await submit(app, 'fix the parser');
    for (let i = 0; i < 100 && releaseTurn === null; i++) await tick(20);

    await submit(app, '/save --raw');
    expect(saveTranscript).toHaveBeenCalledTimes(1);
    expect(saveTranscript.mock.calls[0][3]).toEqual({ redact: false });
    expect(savedWith().meta.midTurn).toBe(true);

    releaseTurn!();
    await tick(120);
    await submit(app, '/save');
    expect(saveTranscript).toHaveBeenCalledTimes(2);
    expect(savedWith().meta.midTurn).toBeUndefined();
    app.unmount();
  });

  it('still queues every other command until the turn ends', async () => {
    runTurn.mockImplementationOnce(runParkedTurn);
    const app = await mountApp();
    await submit(app, 'fix the parser');
    for (let i = 0; i < 100 && releaseTurn === null; i++) await tick(20);

    await submit(app, '/plan');
    // Queued, not switched: the receipt is up and the mode has not changed.
    expect(plain(app.lastFrame())).not.toContain('Plan mode');
    releaseTurn!();
    await tick(200);
    await submit(app, '/save');
    expect(savedWith().meta.mode).toBe('plan');
    app.unmount();
  });
});
