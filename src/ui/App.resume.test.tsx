import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle, Message } from '../types.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as SessionsModule from '../store/sessions.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// Auto-save and /resume (#1) through the real App: a turn lands a session file, /new starts
// another, and /resume brings the first back into both the scrollback and the model's history.

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
  autosave: true,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/tmp/app-resume-test',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../config.js');
  return { ...actual, loadConfig: () => CONFIG, resolveDefaultMode: () => 'agent' };
});

vi.mock('../context/bootstrap.js', async importActual => ({
  ...(await importActual<object>()),
  bootstrap: async () => BUNDLE,
}));

// The real module reads and writes ~/.config/reika/state.json (#365); the test must neither start
// in whoever ran it last's mode nor leave its own behind.
vi.mock('../laststate.js', async () => {
  const actual = await vi.importActual<typeof LastStateModule>('../laststate.js');
  return { ...actual, loadLastState: () => ({}), saveLastState: () => {} };
});
vi.mock('./pr.js', () => ({ resolvePr: async () => null }));

// Redirect the history root: the real one is the user's ~/.config.
const ROOT = mkdtempSync(join(tmpdir(), 'reika-resume-'));
vi.mock('../store/sessions.js', async () => {
  const actual = await vi.importActual<typeof SessionsModule>('../store/sessions.js');
  return {
    ...actual,
    ROOT_HISTORY_DIR: ROOT,
    projectHistoryDir: (cwd: string) => actual.projectHistoryDir(cwd, ROOT),
  };
});

type TurnOpts = { userInput: string; history: Message[]; onMessage: (m: Message) => void };
const historiesSeen: Message[][] = [];
const runTurn = vi.fn(async (opts: TurnOpts) => {
  historiesSeen.push([...opts.history]);
  const user: Message = { role: 'user', content: opts.userInput };
  const reply: Message = { role: 'assistant', content: `re: ${opts.userInput}` };
  // The real loop appends to the persistent history as well as the scrollback.
  opts.history.push(user, reply);
  opts.onMessage(user);
  opts.onMessage(reply);
});
vi.mock('../agent/loop.js', () => ({
  runTurn: (...a: unknown[]) => runTurn(...(a as [TurnOpts])),
}));

const { App } = await import('./App.js');
const { listSessions, projectHistoryDir, writeSession } = await import('../store/sessions.js');

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

function inputLine(app: { lastFrame: () => string | undefined }): string {
  const rows = plain(app.lastFrame())
    .split('\n')
    .filter(l => l.includes('│') && l.includes('> '));
  return rows[rows.length - 1] ?? '';
}

// Retried until echoed: see App.save.test.tsx for why the first write can be dropped.
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
  await tick(150);
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await tick(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const projectDir = projectHistoryDir(BUNDLE.cwd);

describe('session auto-save and /resume', () => {
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    runTurn.mockClear();
    historiesSeen.length = 0;
  });

  it('saves a session per conversation and resumes one into the model history', async () => {
    const app = await mountApp();
    await submit(app, 'fix the parser');
    await waitFor(async () => (await listSessions(projectDir)).length === 1, 'the first save');

    await submit(app, '/new');
    await submit(app, 'something else');
    await waitFor(async () => (await listSessions(projectDir)).length === 2, 'the second save');

    await submit(app, '/resume');
    await waitFor(() => plain(app.lastFrame()).includes('• Resume'), 'the picker');
    // Newest first and the current session left out, so the only entry is the first conversation.
    expect(plain(app.lastFrame())).toContain('fix the parser');
    expect(plain(app.lastFrame())).toContain('msgs · test-model');
    expect(plain(app.lastFrame())).not.toMatch(/› .*something else/);
    app.stdin.write('\r');
    await waitFor(() => plain(app.lastFrame()).includes('Resumed "fix the parser"'), 'the resume');

    await submit(app, 'carry on');
    const history = historiesSeen.at(-1)!;
    expect(history.map(m => ('content' in m ? m.content : m.role))).toEqual([
      'fix the parser',
      're: fix the parser',
    ]);

    // Continuing a project session rewrites its own file rather than starting a third.
    await waitFor(async () => {
      const entries = await listSessions(projectDir);
      return entries.length === 2 && entries[0].title === 'fix the parser';
    }, 'the resumed session to be re-saved in place');
    app.unmount();
  });

  it('leaves a resumed project session untouched until something new happens', async () => {
    const app = await mountApp();
    await submit(app, 'fix the parser');
    await waitFor(async () => (await listSessions(projectDir)).length === 1, 'the first save');
    await submit(app, '/new');
    await tick(200);
    const [entry] = await listSessions(projectDir);
    const before = readFileSync(entry.path, 'utf8');

    await submit(app, '/resume');
    await waitFor(() => plain(app.lastFrame()).includes('• Resume'), 'the picker');
    app.stdin.write('\r');
    await waitFor(() => plain(app.lastFrame()).includes('Resumed "fix the parser"'), 'the resume');
    await submit(app, '/help');
    await tick(300);
    expect(readFileSync(entry.path, 'utf8')).toBe(before);
    app.unmount();
  });

  it('shows the resuming label while the resumed scrollback is built', async () => {
    const app = await mountApp();
    await submit(app, 'fix the parser');
    await waitFor(async () => (await listSessions(projectDir)).length === 1, 'the first save');
    // A second conversation, so the picker has something the current session isn't.
    await submit(app, '/new');
    await submit(app, 'something else');
    await waitFor(async () => (await listSessions(projectDir)).length === 2, 'the second save');
    await submit(app, '/resume');
    await waitFor(() => plain(app.lastFrame()).includes('• Resume'), 'the picker');
    // Only frames from the selection on: the label is its own frame, and the picker's must not
    // count as one.
    app.frames.length = 0;
    app.stdin.write('\r');
    await waitFor(() => plain(app.lastFrame()).includes('Resumed "fix the parser"'), 'the resume');

    // Reading the file is async and drawing the resumed scrollback is not, so the label is
    // committed and written before the whole session lands in one synchronous pass — which is the
    // entire reason it exists: nothing after that commit can paint until it finishes.
    const label = app.frames.map(plain).find(f => f.includes('Resuming "fix the parser"'));
    expect(label).toBeDefined();
    expect(label).not.toContain('• Resume');
    expect(label).toContain('Resuming "fix the parser"…');
    app.unmount();
  });

  it('says when there is nothing to resume', async () => {
    const app = await mountApp();
    await submit(app, '/resume');
    await waitFor(
      () => plain(app.lastFrame()).includes('No saved sessions for this project yet.'),
      'the empty notice',
    );
    app.unmount();
  });

  it('falls back to the /save files when the project has none, and leaves them as they were', async () => {
    const manual = join(ROOT, 'manual.jsonl');
    await writeSession(
      manual,
      { agent: [{ role: 'user', content: 'an old manual save' }], chat: [] },
      {
        version: 1,
        savedAt: '2026-09-01T00:00:00.000Z',
        model: 'test-model',
        baseURL: CONFIG.baseURL,
        cwd: BUNDLE.cwd,
        messageCount: 1,
        mode: 'agent',
      },
    );
    const before = readFileSync(manual, 'utf8');
    const app = await mountApp();
    await submit(app, '/resume');
    await waitFor(() => plain(app.lastFrame()).includes('none for this project'), 'the fallback');
    app.stdin.write('\r');
    await waitFor(() => plain(app.lastFrame()).includes('Resumed "an old manual save"'), 'resume');

    // Opened and left alone, it writes nothing — no project copy of the manual save.
    await tick(300);
    expect(await listSessions(projectDir)).toEqual([]);

    // The continuation is saved as a project session; the manual file is untouched.
    await submit(app, 'keep going');
    await waitFor(async () => (await listSessions(projectDir)).length === 1, 'the project save');
    expect(readFileSync(manual, 'utf8')).toBe(before);
    app.unmount();
  });
});
