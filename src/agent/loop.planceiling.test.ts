import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The plan round ceiling through real dispatch: 12 without a window, 30 while the write has room,
// with the ledger ramping to firm and STOP ahead of it. A 1M-window API run was cut at round 12
// with the context 7% full and no pressure line ever shown.

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  calls: [] as { request: string; tools: unknown[] }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(
    async (opts: {
      system: string;
      history: Message[];
      tools: unknown[];
      trailingNote?: string;
    }) => {
      // Prefix-stable mode carries the plan ledger in the trailing note, not the system block.
      h.calls.push({
        request: opts.system + JSON.stringify(opts.history) + (opts.trailingNote ?? ''),
        tools: opts.tools,
      });
      return h.scripted.shift() ?? { content: 'the plan', toolCalls: undefined };
    },
  ),
}));

// Read at module load; pinned so the windowed arm takes the same path whatever the default.
const PRIOR = process.env.REIKA_PREFIX_STABLE;
process.env.REIKA_PREFIX_STABLE = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR;
});
const { runTurn } = await import('./loop.js');

let payloadChars = 0;
let reads = 0;
const readTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async args => {
    reads++;
    return {
      summary: `Read ${String(args.path)}`,
      payload: `contents of ${args.path}\n${'lorem ipsum dolor sit amet '.repeat(payloadChars / 27)}`,
    };
  },
};

function makeBundle(cwd: string): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd,
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
    maxTurns: 40,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
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
    ...(contextWindow ? { contextWindow } : {}),
  };
}

// A new file every round, so novelty never stalls and only the ceiling can end exploration.
function exploreRounds(n: number): void {
  for (let i = 0; i < n; i++) {
    h.scripted.push({
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'read', args: { path: `src/f${i}.ts` } }],
    });
  }
}

async function runPlan(cwd: string, contextWindow?: number): Promise<void> {
  await runTurn({
    userInput: 'plan it',
    history: [],
    bundle: makeBundle(cwd),
    config: makeConfig(contextWindow),
    tools: [readTool],
    payloads: new PayloadStore(),
    promptMode: 'plan',
    onMessage: () => {},
  });
}

// The first request sent without tools is the force-write.
function forcedAt(): number {
  return h.calls.findIndex(c => c.tools.length === 0);
}

describe('plan round ceiling', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-planceil-'));
    h.scripted.length = 0;
    h.calls.length = 0;
    payloadChars = 0;
    reads = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('keeps 12 rounds without a window', async () => {
    exploreRounds(40);
    await runPlan(cwd);
    expect(forcedAt()).toBe(12);
  });

  it('keeps exploring past 12 on a roomy window and forces the write at 30', async () => {
    exploreRounds(40);
    await runPlan(cwd, 1_000_000);
    expect(forcedAt()).toBe(30);
  });

  // A 24k window's write holds ~70k chars, outgrown after a handful of 8k reads, so it keeps 12 —
  // where a fill rule would not: the shed holds fill near half while the model keeps reading.
  it('keeps 12 rounds on a small window once the findings outgrow the write budget', async () => {
    payloadChars = 8000;
    exploreRounds(40);
    await runPlan(cwd, 24_576);
    expect(reads).toBe(12);
  });

  it('ramps the ledger ahead of the roomy ceiling, naming rounds rather than fill', async () => {
    exploreRounds(40);
    await runPlan(cwd, 1_000_000);
    expect(h.calls[26].request).not.toContain('very likely have enough');
    expect(h.calls[27].request).toContain('You have explored across 27 rounds');
    expect(h.calls[27].request).not.toContain('% full');
    expect(h.calls[29].request).toContain('STOP. Call no more tools.');
  });
});
