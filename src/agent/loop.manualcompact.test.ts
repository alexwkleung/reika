import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// /compact (issue #481): a manual compaction runs the loop's own shrink event — compaction-note
// request, fold, session-cumulative counters — with no user turn behind it and no reply round after
// the fold. The sync requirement cuts both ways: a manual fold must number itself off the
// automatic folds, and an automatic fold after it must advance the same counter.
//
// Pinned to the flag-off path: under REIKA_PREFIX_STABLE the batch-age shed runs first on this
// history and is its own event (loop.shrink.prefixstable.test.ts covers that arm).
const PRIOR_STABLE = process.env.REIKA_PREFIX_STABLE;
process.env.REIKA_PREFIX_STABLE = '0';
afterAll(() => {
  if (PRIOR_STABLE === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR_STABLE;
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
const calls: ModelResponse[] = h.scripted as unknown as ModelResponse[];
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => calls.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');
const client = await import('../provider/client.js');

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

// Small window so the seeded history crosses the fold threshold with room to spare.
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
    contextWindow: 8192,
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
}

const readTool: Tool = {
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

describe('manual compaction (/compact)', () => {
  it('runs one note request and folds, with no user turn and no reply round', async () => {
    h.scripted.length = 0;
    // The turn's only model call: the note request. A reply round (or a pushed user turn) would
    // come back "done" here and the assertions below would catch either.
    h.scripted.push({ content: 'Carry: the task is refactoring A. Open: B.', toolCalls: undefined });
    const history = bigHistory();
    const events: { kind: string; removed?: number; round?: number }[] = [];
    const notices: string[] = [];
    await runTurn({
      userInput: '/compact',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [readTool],
      payloads: new PayloadStore(),
      manualCompact: true,
      onMessage: m => {
        if (m.role === 'system') notices.push(m.content);
      },
      onShrink: e => events.push(e as { kind: string }),
    });

    expect(vi.mocked(client.callModel)).toHaveBeenCalledTimes(1);
    expect(
      history.some(m => (m as { content?: string }).content === '/compact'),
    ).toBe(false);
    const fold = events.filter(e => e.kind === 'fold')[0];
    expect(fold).toBeDefined();
    expect(fold.round).toBe(0);
    expect(fold.removed).toBeGreaterThan(0);
    const compacted = history.find(m => m.role === 'compaction');
    expect(compacted?.content).toContain('Carry: the task is refactoring A.');
    expect(notices.join('\n')).toMatch(/^\/compact — asking the model for a compaction note/);
    expect(notices.join('\n')).toMatch(/Context compacted \(fold 1\)/);
  });

  it('advances the shared counter from priorShrink, in sync with automatic folds', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'note two', toolCalls: undefined });
    const counts: unknown[] = [];
    await runTurn({
      userInput: '/compact',
      history: bigHistory(),
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [readTool],
      payloads: new PayloadStore(),
      manualCompact: true,
      priorShrink: { sheds: 1, folds: 2 },
      onMessage: () => {},
      onShrink: (_e, c) => counts.push({ ...c }),
    });
    expect(counts[0]).toEqual({ sheds: 1, folds: 3 });
  });

  it('says honestly when the keep budget still holds everything', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'note', toolCalls: undefined });
    const notices: string[] = [];
    await runTurn({
      userInput: '/compact',
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [readTool],
      payloads: new PayloadStore(),
      manualCompact: true,
      onMessage: m => {
        if (m.role === 'system') notices.push(m.content);
      },
    });
    expect(notices.some(n => n.startsWith('Nothing to compact'))).toBe(true);
    expect(notices.some(n => n.startsWith('Context compacted'))).toBe(false);
  });
});
