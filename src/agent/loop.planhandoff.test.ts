import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import type { PromptMode } from './prompt.js';

// The gate const PLAN_HANDOFF_DISTILL is read at import time, so the flag must be set before
// loop.js is imported. This file therefore tests the flag-ON wiring: that in the real runTurn loop,
// a plan→agent handoff folds the seeded exploration while leaving the plan verbatim, and that the
// runtime guards (chat mode, no plan-final marker) still pass through with the flag on. The flag's
// own gating is a one-line env check; the fold/no-op logic is unit-tested in compaction.test.ts.
const PRIOR = process.env.REIKA_PLAN_HANDOFF;
process.env.REIKA_PLAN_HANDOFF = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_PLAN_HANDOFF;
  else process.env.REIKA_PLAN_HANDOFF = PRIOR;
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

const PAYLOAD = 'PAYLOAD_A'.repeat(20);

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
    autoApprove: true,
    subagentMaxTurns: 5,
    profiles: {},
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
  };
}

// A finished plan-mode history: request, one read round, then the converged plan (the anchor).
function planHistory(): Message[] {
  return [
    { role: 'user', content: 'add a feature' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: PAYLOAD },
    { role: 'assistant', content: '1. edit a.ts', planFinal: true },
  ];
}

async function run(history: Message[], promptMode: PromptMode): Promise<Message[]> {
  h.scripted.push({ content: 'executed', toolCalls: undefined });
  await runTurn({
    userInput: 'go',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    promptMode,
  });
  return history;
}

describe('plan→agent handoff distillation (integration)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });

  it('folds the plan-mode exploration on the executing agent turn, keeping the plan verbatim', async () => {
    const history = await run(planHistory(), 'agent');
    // The raw read transcript is gone, replaced by a single compaction digest…
    expect(history.some(m => m.role === 'tool')).toBe(false);
    const compaction = history.filter(m => m.role === 'compaction');
    expect(compaction).toHaveLength(1);
    expect((compaction[0] as { content: string }).content).toContain('a.ts');
    // …the request is still pinned at the front and the plan survives verbatim as the anchor.
    expect(history[0]).toMatchObject({ role: 'user', content: 'add a feature' });
    expect(history.some(m => m.role === 'assistant' && m.planFinal)).toBe(true);
  });

  it('does not fold in chat mode (guard is agent-only)', async () => {
    const history = await run(planHistory(), 'chat');
    expect(history.some(m => m.role === 'compaction')).toBe(false);
    expect(history.some(m => m.role === 'tool')).toBe(true);
  });

  it('marks a naturally-completed plan, not only a force-written one', async () => {
    // The model converges and writes the plan on its own at round 0 (no force-write). This is the
    // common case that the old planForceWrite-only marker missed → folded=0 reason=no-marker.
    const history: Message[] = [];
    h.scripted.push({ content: '1. edit a.ts\n2. edit b.ts', toolCalls: undefined });
    await runTurn({
      userInput: 'plan the change',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'plan',
    });
    const planMsg = history.filter(m => m.role === 'assistant').at(-1);
    expect(planMsg).toMatchObject({ planFinal: true });
  });

  it('does not fold an ordinary agent turn with no plan-final marker', async () => {
    const ordinary: Message[] = [
      { role: 'user', content: 'add a feature' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: PAYLOAD },
      { role: 'assistant', content: 'an earlier answer' },
    ];
    const history = await run(ordinary, 'agent');
    expect(history.some(m => m.role === 'compaction')).toBe(false);
    expect(history.some(m => m.role === 'tool')).toBe(true);
  });
});
