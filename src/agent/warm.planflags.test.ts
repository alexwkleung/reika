import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { messagesToOpenAI } from '../provider/toolcall.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// The gate consts PLAN_ALIGN / PLAN_HANDOFF_DISTILL are read at loop.js import time, so the
// flags must be set before the import. This file locks the warm prefix to runTurn's round 0
// under BOTH flags: the PLAN_ALIGN progress ledger must ride the warm system identically, and
// the plan→agent handoff distillation must fold the warm's history copy exactly as the real
// turn folds its own — while the caller's array stays untouched.
const PRIOR_ALIGN = process.env.REIKA_PLAN_ALIGN;
const PRIOR_HANDOFF = process.env.REIKA_PLAN_HANDOFF;
process.env.REIKA_PLAN_ALIGN = '1';
process.env.REIKA_PLAN_HANDOFF = '1';
afterAll(() => {
  if (PRIOR_ALIGN === undefined) delete process.env.REIKA_PLAN_ALIGN;
  else process.env.REIKA_PLAN_ALIGN = PRIOR_ALIGN;
  if (PRIOR_HANDOFF === undefined) delete process.env.REIKA_PLAN_HANDOFF;
  else process.env.REIKA_PLAN_HANDOFF = PRIOR_HANDOFF;
});

// History snapshotted at call time — runTurn mutates the same array after the call (it pushes
// the final assistant reply), so mock.calls inspected post-turn would over-count.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as { system: string; history: Message[] }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { system: string; history: Message[] }) => {
    h.captured.push({ system: opts.system, history: opts.history.slice() });
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');
const { buildWarmPayload } = await import('./warm.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
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

// A finished plan-mode turn: exploration plus the converged plan (the distillation anchor and
// the PLAN_ALIGN checklist seed).
function planHistory(): Message[] {
  return [
    { role: 'user', content: 'add a feature' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: 'PAYLOAD_A'.repeat(20) },
    { role: 'assistant', content: '1. edit a.ts\n2. edit b.ts', planFinal: true },
  ];
}

describe('warm prefix under REIKA_PLAN_ALIGN + REIKA_PLAN_HANDOFF', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
    vi.mocked(callModel).mockClear();
  });

  it('matches the real round-0 request byte-for-byte on an executing agent turn', async () => {
    const config = makeConfig();
    const preTurn = planHistory();
    const untouched = structuredClone(preTurn);

    const warm = buildWarmPayload({
      history: preTurn,
      bundle: makeBundle(),
      config,
      tools: [],
      promptMode: 'agent',
      calibration: 1,
    });
    // The warm distilled its own copy; the caller's array is untouched.
    expect(preTurn).toEqual(untouched);
    // The distillation actually ran on the warm copy (exploration folded to a recap).
    expect(warm.history.some(m => m.role === 'compaction')).toBe(true);
    expect(warm.history.some(m => m.role === 'tool')).toBe(false);
    // The PLAN_ALIGN checklist rides the warm system.
    expect(warm.system).toContain('1. edit a.ts');

    h.scripted.push({ content: 'executed', toolCalls: undefined });
    await runTurn({
      userInput: 'implement the plan',
      history: preTurn,
      bundle: makeBundle(),
      config,
      tools: [],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'agent',
    });
    const real = h.captured[0];

    expect(warm.system).toBe(real.system);
    const opts = {
      contextWindow: config.contextWindow,
      calibration: 1,
      reasoningRounds: config.reasoningRounds,
      minGenTokens: config.minGenTokens,
    };
    const warmMsgs = messagesToOpenAI(warm.system, warm.history, opts);
    const realMsgs = messagesToOpenAI(real.system, real.history, opts);
    expect(realMsgs.length).toBe(warmMsgs.length + 1);
    expect(realMsgs.slice(0, warmMsgs.length)).toEqual(warmMsgs);
  });
});
