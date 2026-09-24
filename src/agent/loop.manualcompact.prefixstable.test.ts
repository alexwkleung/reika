import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The default (prefix-stable) arm of loop.manualcompact.test.ts. Since #181 this regime is the
// default whenever a window is known, so the env var is deleted rather than set. The seeded
// history sits between the keep budget and the batch-age watermark — /compact's own use case
// (#481): something to fold, no pressure to fold it. The note must still be written there; gating
// the manual round on foldAfterShed's watermark half skipped it exactly in this band.
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

// Sized to overflow the keep budget (~8.6k chars at this window) while staying under the batch-age
// watermark (~18k chars), so a fold is due and no shrink pressure says so. The weight sits in
// assistant content — the keep-budget walk prices tool messages at their summary only.
function mediumHistory(): Message[] {
  const out: Message[] = [];
  for (let t = 0; t < 4; t++) {
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
      payload: 'x'.repeat(200),
    });
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(3000)}` });
  }
  return out;
}

// The other side of the manual trigger's band: the weight sits in tool payloads, which push the
// estimate past the trigger (so a shed fires) but which the keep-budget walk prices at their summary
// (so the fold afterwards finds nothing to fold). Exactly where a "still verbatim" claim would be
// false. Sized by measurement: estimate ~8.6k tokens vs the 6.5k trigger, keep-walk ~6.3k chars vs
// the 8.6k budget.
function payloadHeavyHistory(): Message[] {
  const out: Message[] = [];
  for (let t = 0; t < 30; t++) {
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
      payload: 'x'.repeat(20000),
    });
    out.push({ role: 'assistant', content: `ok ${t} ${'y'.repeat(100)}` });
  }
  return out;
}

describe('manual compaction under the default prefix-stable regime (#481)', () => {
  it('writes the note and folds below the batch-age watermark, with no shed', async () => {
    h.scripted.length = 0;
    h.scripted.push({ content: 'Carry: refactoring A is open.', toolCalls: undefined });
    const history = mediumHistory();
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
    expect(history.some(m => (m as { content?: string }).content === '/compact')).toBe(false);
    // Under the shrink trigger: nothing may be shed ahead of the fold — that band is exactly the
    // one where the pre-fix gate folded without a note.
    expect(events.filter(e => e.kind === 'age')).toHaveLength(0);
    const fold = events.filter(e => e.kind === 'fold')[0];
    expect(fold).toBeDefined();
    expect(fold.round).toBe(0);
    expect(fold.removed).toBeGreaterThan(0);
    const compacted = history.find(m => m.role === 'compaction');
    expect(compacted?.content).toContain('Carry: refactoring A is open.');
    expect(notices.join('\n')).toMatch(/^\/compact — asking the model for a compaction note/);
    expect(notices.join('\n')).toMatch(/Context compacted \(fold 1\)/);
  });

  it('owns up to the shed when it fires and leaves nothing to fold', async () => {
    h.scripted.length = 0;
    // Shared spy: the earlier test's note request is still on the count.
    vi.mocked(client.callModel).mockClear();
    const history = payloadHeavyHistory();
    const events: { kind: string }[] = [];
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

    expect(events.filter(e => e.kind === 'age').length).toBeGreaterThan(0);
    expect(events.filter(e => e.kind === 'fold')).toHaveLength(0);
    expect(history.some(m => m.role === 'tool' && m.aged)).toBe(true);
    // No note either: without a fold there is no recap for it to live in (#280's gate).
    expect(vi.mocked(client.callModel)).toHaveBeenCalledTimes(0);
    // The message must not claim everything is verbatim right after the shed summarized it.
    expect(notices.join('\n')).toMatch(/Nothing to compact — the batch-age shed just summarized/);
    expect(notices.join('\n')).not.toMatch(/verbatim/);
  });
});
