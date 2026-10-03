import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// Per-mode models (#616) through the real App: REIKA_MODE_MODELS says which model each mode runs,
// a mode switch applies it, a mode without one comes back to the session's model, and a hand-picked
// /model outranks the map for the rest of the session. Parsing and resolution of the map are
// unit-tested in config.test.ts and laststate.test.ts; what is asserted here is the part that only
// exists in a session — when the model moves (startup, mode change, /new) and when it does not.

const BASE = 'http://127.0.0.1:1/v1';
const PROFILE = { baseURL: BASE, apiKey: 'test', contextWindow: 8000 };

const CONFIG: Config = {
  baseURL: BASE,
  apiKey: 'test',
  model: 'test-model',
  models: ['test-model'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'off',
  subagentMaxTurns: 5,
  profiles: {
    default: { ...PROFILE, model: 'test-model' },
    kimi: { ...PROFILE, model: 'kimi-k2' },
    go: { ...PROFILE, model: 'go-model' },
  },
  modeProfiles: { plan: 'kimi' },
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
  cwd: '/tmp/app-modemodel-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

// setAtLaunch reads the keys present in process.env when config.ts is imported, so a developer
// shell that exports REIKA_MODEL counts as a launch pin — which beats the per-mode map by design
// (#616) and would fail these tests on their machine but nowhere else. Pin nothing.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return {
    ...actual,
    loadConfig: () => CONFIG,
    resolveDefaultMode: () => 'agent',
    setAtLaunch: () => false,
  };
});
vi.mock('../context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));
// The real module reads and writes ~/.config/reika/state.json (#365); the test must neither start
// in whoever ran it last's mode nor leave its own behind. A test that wants a saved mode sets it.
const lastState: { value: LastStateModule.LastState } = { value: {} };
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => lastState.value, saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));
vi.mock('../agent/loop.js', () => ({ runTurn: async () => {} }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

type Harness = { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined };

/** The contents of the input row, whatever prompt the mode draws it with (`> `, or `$ ` in shell). */
function inputLine(app: Harness): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && /[>$?] /.test(l));
  return rows[rows.length - 1] ?? '';
}

async function submit(app: Harness, text: string) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
  app.stdin.write('\r');
  await tick(150);
}

/** The model the status bar names — which model a turn would actually run on. */
function statusModel(app: Harness): string {
  const row = plain(app.lastFrame())
    .split('\n')
    .find(l => l.includes('shift+tab to cycle'));
  return (row ?? '').split('·')[1]?.trim() ?? '';
}

async function waitForStatus(app: Harness, model: string): Promise<string> {
  for (let i = 0; i < 100 && statusModel(app) !== model; i++) await tick(25);
  expect(statusModel(app)).toBe(model);
  return plain(app.lastFrame());
}

/** The frame once `text` has shown up in it — the switch lands a render after the mode does. */
async function waitFor(app: Harness, text: string): Promise<string> {
  for (let i = 0; i < 100 && !plain(app.lastFrame()).includes(text); i++) await tick(25);
  const frame = plain(app.lastFrame());
  expect(frame).toContain(text);
  return frame;
}

describe('per-mode models in the session (#616)', () => {
  afterEach(() => {
    lastState.value = {};
  });

  it('runs the mode model, and comes back to the session model after it', async () => {
    const app = await mountApp();
    expect(statusModel(app)).toBe('test-model');

    // Shell runs no model, so entering it moves nothing (the same rule the config map applies:
    // only the modes a turn reaches the model in have one to choose).
    await submit(app, '/shell');
    await waitFor(app, 'Shell mode');
    expect(plain(app.lastFrame())).not.toContain('Switched to');
    expect(statusModel(app)).toBe('test-model');

    await submit(app, '/plan');
    await waitFor(app, "Switched to profile 'kimi' (kimi-k2)");
    await waitForStatus(app, 'kimi-k2');

    // Agent has no model of its own, so it is the session's that comes back — not the plan one.
    await submit(app, '/agent');
    await waitForStatus(app, 'test-model');
    app.unmount();
  });

  it('opens on the start mode model over the profile the last session saved', async () => {
    lastState.value = { mode: 'plan', profile: 'go' };
    const app = await mountApp();
    await waitFor(app, "Resumed plan mode and profile 'kimi' (kimi-k2)");
    await waitForStatus(app, 'kimi-k2');
    app.unmount();
  });

  it('applies the map again after /new, and stops applying it once /model picks a model', async () => {
    const app = await mountApp();
    await submit(app, '/plan');
    await waitForStatus(app, 'kimi-k2');

    // /new is a new session: it drops to the default profile without a switch line (that reset is
    // not a choice), and the map applies again from there.
    await submit(app, '/new');
    await waitFor(app, 'New session');
    await waitForStatus(app, 'test-model');

    await submit(app, '/model go');
    await waitFor(app, "Switched to profile 'go' (go-model)");
    await submit(app, '/plan');
    await waitFor(app, 'Plan mode');
    await tick(150);
    // The mode moved, the model did not: the map is off for the rest of this session.
    expect(statusModel(app)).toBe('go-model');
    expect(plain(app.lastFrame())).toContain('Plan mode');

    await submit(app, '/new');
    await waitFor(app, 'New session');
    await submit(app, '/plan');
    await waitForStatus(app, 'kimi-k2');
    app.unmount();
  });

  it('says so at startup when a REIKA_MODE_MODELS entry named nothing', async () => {
    CONFIG.modeModelErrors = [
      "REIKA_MODE_MODELS: ignoring 'plan=kimi-k2' — no profile or model named 'kimi-k2' in your config.",
    ];
    try {
      const app = await mountApp();
      // A fragment, not the sentence: the notice wraps at the terminal width mid-clause.
      await waitFor(app, "REIKA_MODE_MODELS: ignoring 'plan=kimi-k2'");
      expect(statusModel(app)).toBe('test-model');
      app.unmount();
    } finally {
      delete CONFIG.modeModelErrors;
    }
  });
});
