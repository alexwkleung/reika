import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import type { PromptMode } from './prompt.js';

// The dropped-payload notice (#227) has to reach the model through EVERY live system composition,
// and there are four of them: {plan, agent} x {system suffix, trailing note under
// REIKA_PREFIX_STABLE}. A unit test on buildSteadySystem only reaches the two default-mode ones —
// plan-mode-under-prefix-stable composes its own suffix inline and was missed entirely on the first
// pass. So this file drives runTurn under the flag and reads what actually got dispatched.
// The gate const PREFIX_STABLE is read at loop.js import time, so set the env before the import.
const PRIOR = process.env.REIKA_PREFIX_STABLE;
process.env.REIKA_PREFIX_STABLE = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR;
});

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as { system: string; trailingNote?: string }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { system: string; trailingNote?: string }) => {
    h.captured.push({ system: opts.system, trailingNote: opts.trailingNote });
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: 'proj',
    repoMap: 'map',
    instructions: '',
    cwd: tmpdir(),
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 10,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    // prefixStableActive needs a known window for its sticky watermarks.
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

// A prior turn whose tool result HAD a payload and has since been aged — the state that serializes
// as a bare summary line and reads to the model as "already handled".
function agedPriorTurn(): Message[] {
  return [
    { role: 'user', content: 'work on issue 213' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'gh issue view 213' } }],
    },
    {
      role: 'tool',
      callId: 'c1',
      summary: 'Ran: gh issue view 213 (505 bytes output)',
      payload: 'ISSUE BODY',
      aged: true,
    },
    { role: 'assistant', content: 'read the issue.' },
  ];
}

async function roundZero(history: Message[], promptMode: PromptMode) {
  h.scripted.push({ content: 'final', toolCalls: undefined });
  await runTurn({
    userInput: 'do the thing',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    promptMode,
  });
  return h.captured[0];
}

describe('dropped-payload notice under REIKA_PREFIX_STABLE (#227)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
  });

  // The regression this file exists for: plan mode composes its prefix-stable suffix inline, so
  // adding the notice to buildSteadySystem alone left a prefix-stable plan run without it.
  for (const promptMode of ['agent', 'plan'] as const) {
    it(`reaches the model through the trailing note in ${promptMode} mode`, async () => {
      const c = await roundZero(agedPriorTurn(), promptMode);
      expect(c.trailingNote ?? '').toContain('Their output was dropped to make room');
      // Under prefix-stable the ledgers ride the tail, never the system block.
      expect(c.system).not.toContain('dropped to make room');
    });

    it(`stays silent in ${promptMode} mode when nothing was dropped`, async () => {
      const clean = agedPriorTurn();
      delete (clean[2] as Message & { role: 'tool' }).payload;
      const c = await roundZero(clean, promptMode);
      expect(c.trailingNote ?? '').not.toContain('dropped to make room');
    });
  }
});
