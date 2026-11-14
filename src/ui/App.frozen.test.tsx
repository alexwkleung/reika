import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Config, ContextBundle } from '../types.js';
import type * as ConfigModule from '../config.js';
import type * as LastStateModule from '../laststate.js';

// A loop-break recovery freezes what had streamed into the scrollback (#55). The controller does
// the freeze and App only clears its own stream, so the frozen row must land exactly once.

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
  cwd: '/tmp/app-frozen-test',
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

type TurnOpts = {
  onMessage: (m: unknown) => void;
  onReasoningDelta?: (d: string) => void;
  onReasoningReset?: () => void;
  userInput: string;
};

let release: () => void = () => {};
const runTurn = vi.fn(async (opts: TurnOpts) => {
  opts.onMessage({ role: 'user', content: opts.userInput });
  opts.onReasoningDelta?.('circling the same FROZENMARK idea');
  opts.onReasoningReset?.();
  opts.onReasoningDelta?.('a fresh LIVEMARK thought');
  await new Promise<void>(r => (release = r));
});
vi.mock('../agent/loop.js', () => ({ runTurn: (...a: unknown[]) => runTurn(...(a as [never])) }));

const { App } = await import('./App.js');

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
const tick = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));
const count = (text: string, word: string): number => text.split(word).length - 1;

describe('a reasoning reset through the real App', () => {
  it('freezes the stream into the scrollback once and streams the next block fresh', async () => {
    const app = render(<App />);
    for (let i = 0; i < 400 && !plain(app.lastFrame()).includes('╭'); i++) await tick(25);
    for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('go now'); i++) {
      app.stdin.write('go now');
      await tick(20);
    }
    app.stdin.write('\r');
    for (let i = 0; i < 200 && !plain(app.lastFrame()).includes('LIVEMARK'); i++) await tick(20);
    const frame = plain(app.lastFrame());
    expect(count(frame, 'FROZENMARK')).toBe(1);
    expect(count(frame, 'LIVEMARK')).toBe(1);
    expect(frame.indexOf('FROZENMARK')).toBeLessThan(frame.indexOf('LIVEMARK'));
    release();
    app.unmount();
  });
});
