import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';

// App owns the whole frame layout and has historically regressed there (#112: the busy
// spinner rendered between the completion list and the input, landing inside the merged
// border). These tests mount the real App with only its I/O boundaries stubbed, then assert
// on the composed frame.

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
  anon: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-render-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG };
});

vi.mock('../context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));

// Shells out to git/gh — stubbed so the footer is deterministic and the test stays hermetic.
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

// A turn that never settles: status stays 'busy' so the Working indicator is up while we
// drive the input. Each test aborts it by unmounting.
const runTurn = vi.fn(() => new Promise<void>(() => {}));
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [])) }));

const { App } = await import('./App.js');

/** Ink writes SGR colour codes into every frame; strip them before matching. */
function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Mount, wait out bootstrap, and return the harness once App is past 'Loading…'. */
async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 40 && plain(app.lastFrame()).includes('Loading…'); i++) await tick(25);
  return app;
}

/** Lines of the current frame, trimmed of the App's paddingX and trailing blanks. */
function lines(app: { lastFrame: () => string | undefined }): string[] {
  return plain(app.lastFrame())
    .split('\n')
    .map(l => l.trim());
}

const BORDER = /^[╭│╰]/u;

/** Index of the first line matching, or -1. */
function findLine(rows: string[], re: RegExp): number {
  return rows.findIndex(l => re.test(l));
}

/** Index of the last line matching, or -1. */
function findLastLine(rows: string[], re: RegExp): number {
  for (let i = rows.length - 1; i >= 0; i--) if (re.test(rows[i])) return i;
  return -1;
}

describe('App layout', () => {
  // Block body on purpose: mockClear() returns the mock, and a function returned from
  // beforeEach is treated as teardown — vitest would then await this never-settling turn.
  beforeEach(() => {
    runTurn.mockClear();
  });

  it('renders the input and footer once bootstrap settles', async () => {
    const app = await mountApp();
    const frame = plain(app.lastFrame());
    expect(frame).not.toContain('Loading…');
    expect(frame).toContain('Type / for commands');
    expect(frame).toContain('test-model');
    app.unmount();
  });

  it('shows the Working indicator above the input during a turn', async () => {
    const app = await mountApp();
    app.stdin.write('hi');
    await tick();
    app.stdin.write('\r');
    await tick(120);

    expect(runTurn).toHaveBeenCalledTimes(1);
    const rows = lines(app);
    const working = findLine(rows, /Working…/);
    const inputTop = findLine(rows, /^╭/);
    expect(working).toBeGreaterThanOrEqual(0);
    // Above the input's own top border, which the input keeps when nothing is attached.
    expect(working).toBeLessThan(inputTop);
    app.unmount();
  });

  // The #112 regression. The completion list drops its bottom border and the input drops its
  // top one so the two read as one frame; anything rendered between them lands *inside* it.
  it('keeps the Working indicator outside the completion/input frame', async () => {
    const app = await mountApp();
    app.stdin.write('hi');
    await tick();
    app.stdin.write('\r');
    await tick(120);
    // Open the slash-command list mid-turn.
    app.stdin.write('/');
    await tick(120);

    const rows = lines(app);
    expect(findLine(rows, /\/help/)).toBeGreaterThanOrEqual(0); // list is actually open

    const working = findLine(rows, /Working…/);
    const frameTop = findLine(rows, /^╭/);
    const frameBottom = findLine(rows, /^╰/);
    expect(working).toBeGreaterThanOrEqual(0);
    expect(frameTop).toBeGreaterThanOrEqual(0);
    expect(frameBottom).toBeGreaterThan(frameTop);

    // The spinner sits above the merged frame, not inside it.
    expect(working).toBeLessThan(frameTop);

    // And the frame really is merged and unbroken: exactly one top and one bottom border,
    // with every line between them part of the box.
    expect(rows.filter(l => l.startsWith('╭'))).toHaveLength(1);
    expect(rows.filter(l => l.startsWith('╰'))).toHaveLength(1);
    for (const row of rows.slice(frameTop, frameBottom + 1)) {
      expect(row).toMatch(BORDER);
    }
    // The prompt is the last row inside the box — the list flows straight into it.
    expect(rows[frameBottom - 1]).toMatch(/^│\s*>/);
    app.unmount();
  });

  it('keeps a queued message outside the completion/input frame', async () => {
    const app = await mountApp();
    app.stdin.write('hi');
    await tick();
    app.stdin.write('\r');
    await tick(120);
    // Queued while the turn is in flight.
    app.stdin.write('later');
    await tick();
    app.stdin.write('\r');
    await tick(120);
    app.stdin.write('/');
    await tick(120);

    const rows = lines(app);
    // Last match, not first: queueing also writes a `[Queued] …` receipt into scrollback,
    // which sits above everything and would make the ordering assertion vacuous.
    const queued = findLastLine(rows, /\[Queued]/);
    const frameTop = findLine(rows, /^╭/);
    const frameBottom = findLine(rows, /^╰/);
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(queued).toBeLessThan(frameTop);
    for (const row of rows.slice(frameTop, frameBottom + 1)) {
      expect(row).toMatch(BORDER);
    }
    app.unmount();
  });
});
