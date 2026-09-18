import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// A shrink event — a batch-age shed or a compaction fold — was visible only in the debug log (sheds)
// or as a once-per-turn notice (folds). The loop now reports every event with session-cumulative
// counts, so the status line can show how many times the window has been worked and a saved
// transcript can carry the events when debug isn't on. The fold notice is numbered session-wide
// and carries the recap size, which is the number #275's stacked recaps made worth seeing.
//
// Pinned to the flag-off path so the seeded history goes straight to a fold: under
// REIKA_PREFIX_STABLE (on by default since #181) the batch-age shed fires first and is itself a
// counted event — loop.shrink.prefixstable.test.ts covers that arm on the same history.
const PRIOR_STABLE = process.env.REIKA_PREFIX_STABLE;
process.env.REIKA_PREFIX_STABLE = '0';
afterAll(() => {
  if (PRIOR_STABLE === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR_STABLE;
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
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
    // Small enough that a seeded history crosses the compaction threshold on round 0.
    contextWindow: 8192,
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

describe('shrink events reach the caller', () => {
  it('reports a fold with session-cumulative counts and numbers the notice from priorShrink', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'final', toolCalls: undefined });
    const history = bigHistory();
    const events: Array<{ event: unknown; counts: unknown }> = [];
    const notices: string[] = [];
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: m => {
        if (m.role === 'system') notices.push(m.content);
      },
      onShrink: (event, counts) => events.push({ event, counts }),
      // Two folds happened in earlier turns: this one is the third of the session.
      priorShrink: { sheds: 4, folds: 2 },
    });

    const folds = events.filter(e => (e.event as { kind: string }).kind === 'fold');
    expect(folds.length).toBeGreaterThanOrEqual(1);
    const first = folds[0].event as {
      kind: 'fold';
      round: number;
      removed: number;
      recapChars: number;
    };
    expect(first.round).toBe(0);
    expect(first.removed).toBeGreaterThan(0);
    // The recap size reported is the spliced recap's — not a count, not an estimate.
    const spliced = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(first.recapChars).toBe(spliced.content.length);
    expect(folds[0].counts).toEqual({ sheds: 4, folds: 3 });

    // The notice is numbered session-wide and carries the recap size.
    const notice = notices.find(n => n.startsWith('Context compacted'));
    expect(notice).toBeDefined();
    expect(notice).toMatch(
      /^Context compacted \(fold 3\) — folded [1-9]\d* earlier messages? into a \d+\.\dk-char recap/,
    );
  });

  it('starts the counts at zero without priorShrink', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'final', toolCalls: undefined });
    const counts: unknown[] = [];
    await runTurn({
      userInput: 'keep going',
      history: bigHistory(),
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      onShrink: (_e, c) => counts.push(c),
    });
    expect(counts[0]).toEqual({ sheds: 0, folds: 1 });
  });
});
