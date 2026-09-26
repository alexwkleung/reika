import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// REASONING_LOOP_BREAK is read at loop.js import time. This file leaves REIKA_REASONING_LOOP UNSET
// to pin the default: on since 2026-09-24, so an unconfigured install must still stop a rumination
// loop at the terminal rather than spin to maxTurns. The steer and bias recoveries (both on by
// default) are pinned off so the stop is the plain ladder's own.
const PRIOR = {
  REIKA_REASONING_LOOP: process.env.REIKA_REASONING_LOOP,
  REIKA_CONVERGE_RETRY: process.env.REIKA_CONVERGE_RETRY,
  REIKA_LOGIT_RECOVERY: process.env.REIKA_LOGIT_RECOVERY,
  REIKA_PREFIX_STABLE: process.env.REIKA_PREFIX_STABLE,
};
delete process.env.REIKA_REASONING_LOOP;
process.env.REIKA_CONVERGE_RETRY = '0';
process.env.REIKA_LOGIT_RECOVERY = '0';
process.env.REIKA_PREFIX_STABLE = '0';
afterAll(() => {
  for (const [key, value] of Object.entries(PRIOR)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[], calls: 0 }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => {
    h.calls++;
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
  hash: 'test',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'bypass',
  subagentMaxTurns: 5,
  profiles: {},
  contextWindow: 16384,
  minGenTokens: 1024,
  reasoningRounds: 1,
  maxSearchesPerTurn: 0,
  maxFetchesPerTurn: 0,
  bashTimeoutMs: 5000,
  bashIdleMs: 5000,
  pasteFetch: 'off',
  skillAuto: 'off',
  anon: false,
  sandbox: false,
};

// Not an inspection tool, so withdrawal can't take it away and only the terminal can end the loop.
const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

const RUMINATION =
  'I need to check whether the helper is exported before I can change the call site, and to do ' +
  'that I should verify the module boundary once more before committing to any concrete edit at all.';

describe('reasoning-loop break default', () => {
  it('stops a byte-identical rumination loop at the terminal with the flag unset', async () => {
    for (let n = 0; n < config.maxTurns; n++) {
      h.scripted.push({
        content: '',
        reasoning: RUMINATION,
        toolCalls: [{ id: `c${n}`, name: 'noop', args: {} }],
      });
    }

    const history: Message[] = [];
    await runTurn({
      userInput: 'fix the bug',
      history,
      bundle,
      config,
      tools: [noop],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'agent',
    });

    expect(h.calls).toBeLessThan(config.maxTurns);
    const last = history.at(-1) as Message & { content: string };
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('kept repeating the same step');
  });
});
