import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// The gate const DEDUP_PAYLOADS is read at toolcall.js import time, so the flag must be set
// before the imports. REIKA_WARM + REIKA_DEDUP_PAYLOADS is a live configuration (.env.example
// ships both on): this locks the warm prefix to the real round-0 request when dedup stubbing is
// rewriting tool content. It composes because stub decisions depend only on (history, freshFrom),
// and at a turn boundary both requests see every tool message as non-fresh with the same
// signatures — the trailing user message the warm lacks can't change a stub.
const PRIOR = process.env.REIKA_DEDUP_PAYLOADS;
process.env.REIKA_DEDUP_PAYLOADS = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_DEDUP_PAYLOADS;
  else process.env.REIKA_DEDUP_PAYLOADS = PRIOR;
});

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

const { messagesToOpenAI } = await import('../provider/toolcall.js');
const { runTurn } = await import('./loop.js');
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
  };
}

// A prior turn containing a byte-identical re-read — the repetition dedup exists to stub.
function loopyPriorTurn(): Message[] {
  const payload = 'const a = 1;'.repeat(10);
  return [
    { role: 'user', content: 'look at a.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c2', summary: 'read a.ts', payload },
    { role: 'assistant', content: 'a.ts defines a.' },
  ];
}

describe('warm prefix under REIKA_DEDUP_PAYLOADS', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
  });

  it('stubs identically in the warm and the real round-0 request (strict prefix holds)', async () => {
    const config = makeConfig();
    const preTurn = loopyPriorTurn();
    const warm = buildWarmPayload({
      history: preTurn,
      bundle: makeBundle(),
      config,
      tools: [],
      promptMode: 'agent',
      calibration: 1,
    });

    h.scripted.push({ content: 'final', toolCalls: undefined });
    await runTurn({
      userInput: 'do the thing',
      history: preTurn.slice(),
      bundle: makeBundle(),
      config,
      tools: [],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'agent',
    });
    const real = h.captured[0];

    const opts = {
      contextWindow: config.contextWindow,
      calibration: 1,
      reasoningRounds: config.reasoningRounds,
      minGenTokens: config.minGenTokens,
    };
    const warmMsgs = messagesToOpenAI(warm.system, warm.history, opts);
    const realMsgs = messagesToOpenAI(real.system, real.history, opts);
    // Dedup actually engaged in the warm payload (the duplicate re-read collapsed to a stub) —
    // otherwise this test would pass vacuously with the flag broken.
    const flat = JSON.stringify(warmMsgs);
    expect(flat).toContain('repeat of an earlier identical result');
    // …and the warm is still a strict message prefix of the real request.
    expect(warm.system).toBe(real.system);
    expect(realMsgs.length).toBe(warmMsgs.length + 1);
    expect(realMsgs.slice(0, warmMsgs.length)).toEqual(warmMsgs);
  });
});
