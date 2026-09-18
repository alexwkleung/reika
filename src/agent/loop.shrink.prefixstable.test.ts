import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The prefix-stable arm of loop.shrink.test.ts, on the same seeded history. Since #181 this is
// the DEFAULT regime whenever REIKA_CONTEXT_WINDOW is set, so the env var is deleted here rather
// than set: the test locks in that an unset flag serializes prefix-stable — a batch-age shed is the
// first shrink event a full window meets, it is a counted event in its own right, and it lands
// before any fold. If the default ever regresses to per-round aging, the first event is a fold
// and this fails. `REIKA_PREFIX_STABLE=0` remains the baseline arm (loop.shrink.test.ts).
const PRIOR_STABLE = process.env.REIKA_PREFIX_STABLE;
delete process.env.REIKA_PREFIX_STABLE;
afterAll(() => {
  if (PRIOR_STABLE === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR_STABLE;
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn, prefixStableActive } = await import('./loop.js');

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

function makeConfig(contextWindow?: number): Config {
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
    // Small enough that a seeded history crosses the compaction threshold on round 0.
    contextWindow,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

const noopTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

function bigHistory(): Message[] {
  const out: Message[] = [];
  for (let t = 0; t < 12; t++) {
    out.push({ role: 'user', content: `task ${t}` });
    out.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${t}`, name: 'read', args: { path: `src/file${t}.ts` } }],
    });
    out.push({
      role: 'tool',
      callId: `c${t}`,
      summary: `Read src/file${t}.ts lines 1-90 of 90`,
      payload: 'x'.repeat(3000),
    });
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(3000)}` });
  }
  return out;
}

describe('prefix-stable is the default with a context window (#181)', () => {
  it('is active with the flag unset and a window, and inactive without a window', () => {
    expect(prefixStableActive(8192)).toBe(true);
    // The precondition is unchanged: sticky liveness needs the batch-aging watermark to bound it.
    expect(prefixStableActive(undefined)).toBe(false);
  });

  it('meets a full window with a batch-age shed as the first counted event', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'final', toolCalls: undefined });
    const history = bigHistory();
    const events: Array<{ event: { kind: string; round: number }; counts: unknown }> = [];
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(8192),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      onShrink: (event, counts) => events.push({ event, counts }),
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event.kind).toBe('age');
    expect(events[0].event.round).toBe(0);
    expect(events[0].counts).toEqual({ sheds: 1, folds: 0 });
    // The shed is sticky on the shared message objects: the aged marks outlive the turn so the
    // next turn's first request stays prefix-aligned with this one.
    expect(history.some(m => m.role === 'tool' && m.aged)).toBe(true);
    // No fold ever precedes the shed.
    const firstFold = events.findIndex(e => e.event.kind === 'fold');
    if (firstFold !== -1) expect(firstFold).toBeGreaterThan(0);
  });
});
