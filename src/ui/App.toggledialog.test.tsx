import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';
import { clearIdentity } from './identity.js';

// The toggle dialogs (#625): bare /approvals, /unattended and /anon ask on/off/cancel instead of
// printing the arg-less default (a status line for /approvals, a blind toggle for the other two).
// Driven through the real App because the deferred-open and keyboard-handling wiring is the same
// submit-path plumbing the /implement picker and the skill confirm live on.

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
  cwd: '/tmp/app-toggledialog-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG };
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
vi.mock('../agent/loop.js', () => ({ runTurn: vi.fn() }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

type Harness = { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined };

async function mountApp() {
  const app = render(<App />);
  for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
  if (!plain(app.lastFrame()).includes('╭')) throw new Error('App never finished loading');
  return app;
}

function inputLine(app: Harness): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

async function type(app: Harness, text: string) {
  for (let i = 0; i < 200 && !inputLine(app).includes(text); i++) {
    app.stdin.write(text);
    await tick(20);
  }
  if (!inputLine(app).includes(text)) throw new Error(`input never echoed: ${text}`);
}

async function submit(app: Harness, text: string) {
  await type(app, text);
  app.stdin.write('\r');
  await tick(120);
}

async function waitFor(app: Harness, re: RegExp, ms = 3000) {
  for (let i = 0; i < ms / 25 && !re.test(plain(app.lastFrame())); i++) await tick(25);
  expect(plain(app.lastFrame())).toMatch(re);
}

describe('toggle dialogs (#625)', () => {
  beforeEach(() => {
    CONFIG.unattended = undefined;
    CONFIG.autoApprove = 'off';
    CONFIG.autoApproveExplicit = false;
    clearIdentity();
  });

  it('/unattended bare asks, and picking off turns it off', async () => {
    CONFIG.unattended = true;
    const app = await mountApp();
    expect(plain(app.lastFrame())).toContain('· unattended');
    await submit(app, '/unattended');
    // The dialog opens instead of toggling: current state on, rows on/off/Cancel.
    await waitFor(app, /• Unattended\s+currently on/);
    const frame = plain(app.lastFrame());
    expect(frame).toContain('1. on');
    expect(frame).toContain('2. off');
    expect(frame).toContain('3. Cancel');
    // The current state's row is preselected, so Enter alone would change nothing.
    expect(frame).toContain('› 1. on');
    expect(frame).toContain('1-3 navigate');
    expect(frame).not.toContain('y/n jump');
    // Digit 2 = off, then Enter applies it.
    app.stdin.write('2');
    await waitFor(app, /› 2\. off/);
    app.stdin.write('\r');
    await waitFor(app, /unattended: off — approvals and questions prompt again/);
    expect(plain(app.lastFrame())).not.toContain('· unattended');
    app.unmount();
  });

  it('/approvals bare asks; picking on turns session auto-approve on', async () => {
    const app = await mountApp();
    expect(plain(app.lastFrame())).not.toContain('auto approve');
    await submit(app, '/approvals');
    await waitFor(app, /• Approvals\s+session auto-approve: off/);
    expect(plain(app.lastFrame())).toMatch(/› 2\. off/);
    app.stdin.write('1');
    await waitFor(app, /› 1\. on/);
    app.stdin.write('\r');
    await waitFor(app, /Session auto-approve: on/);
    expect(plain(app.lastFrame())).toContain('auto approve');
    app.unmount();
  });

  it('/anon bare asks; picking on anonymizes', async () => {
    const app = await mountApp();
    await submit(app, '/anon');
    await waitFor(app, /• Anonymize\s+currently off/);
    app.stdin.write('1');
    await waitFor(app, /› 1\. on/);
    app.stdin.write('\r');
    await waitFor(app, /anonymize: on/);
    app.unmount();
  });

  it('esc cancels without applying or printing a receipt', async () => {
    const app = await mountApp();
    await submit(app, '/unattended');
    await waitFor(app, /• Unattended/);
    app.stdin.write('\x1b');
    await tick(200);
    expect(plain(app.lastFrame())).not.toMatch(/• Unattended/);
    expect(plain(app.lastFrame())).not.toContain('unattended: on —');
    expect(plain(app.lastFrame())).not.toContain('unattended: off —');
    // The command itself is the only scrollback record, like a dismissed /model picker.
    expect(plain(app.lastFrame())).toContain('/unattended');
    app.unmount();
  });

  it('explicit on/off still applies directly, without a dialog', async () => {
    const app = await mountApp();
    await submit(app, '/approvals on');
    expect(plain(app.lastFrame())).not.toMatch(/• Approvals/);
    expect(plain(app.lastFrame())).toContain('Session auto-approve: on');
    await submit(app, '/unattended on');
    expect(plain(app.lastFrame())).not.toMatch(/• Unattended/);
    expect(plain(app.lastFrame())).toContain('unattended: on —');
    app.unmount();
  });

  it('an env-forced approvals keeps the status line: the toggle is shadowed', async () => {
    CONFIG.autoApprove = 'bypass';
    CONFIG.autoApproveExplicit = true;
    const app = await mountApp();
    await submit(app, '/approvals');
    expect(plain(app.lastFrame())).not.toMatch(/• Approvals/);
    expect(plain(app.lastFrame())).toContain('auto-approve: bypass');
    expect(plain(app.lastFrame())).toContain(
      'env REIKA_AUTO_APPROVE forces this; session toggle is shadowed',
    );
    app.unmount();
  });

  it('a stray /anon argument is rejected like the other two commands', async () => {
    const app = await mountApp();
    await submit(app, '/anon maybe');
    expect(plain(app.lastFrame())).not.toMatch(/• Anonymize/);
    expect(plain(app.lastFrame())).toContain('Unknown argument: maybe. Use /anon on or /anon off.');
    app.unmount();
  });
});
