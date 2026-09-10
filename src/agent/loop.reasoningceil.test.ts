import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// REIKA_REASONING_CEIL exists so the ceiling branch is reachable in a bench without editing the
// constant for a run — which is how an A/B ends up comparing two different builds. That makes the
// knob itself load-bearing for the measurement, so it gets a test: a block far UNDER the 32000
// default must still be cut when the env lowers the ceiling to 3000.

const h = vi.hoisted(() => ({ stream: [] as string[], scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onReasoningDelta?: (t: string) => void }) => {
    const chunk = h.stream.shift();
    if (chunk) {
      for (let i = 0; i < chunk.length; i += 1000)
        opts.onReasoningDelta?.(chunk.slice(i, i + 1000));
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

// Read at module load, so the env must be set before loop.js is imported.
const PRIOR = { ...process.env };
process.env.REIKA_REASONING_CEIL = '3000';
process.env.REIKA_VERBATIM_ABORT = '1';
process.env.REIKA_CONTINUE = '1';
afterAll(() => {
  process.env = PRIOR;
});
const { runTurn } = await import('./loop.js');

// ~7,000 chars: comfortably past the lowered ceiling, nowhere near the 32000 default.
function healthy(n = 60): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `step ${i}: the line at index ${i} ends at offset ${i * 7}, so the previous line starts ` +
      `after the newline at ${i * 7 - 1} and the walk continues to candidate ${i + 1}`,
  ).join('\n');
}

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

describe('REIKA_REASONING_CEIL', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-ceil-'));
    h.stream.length = 0;
    h.scripted.length = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('cuts a block that the default ceiling would have let run', async () => {
    const block = healthy();
    expect(block.length).toBeGreaterThan(3000);
    expect(block.length).toBeLessThan(32000);

    h.stream.push(block);
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'done', toolCalls: undefined },
    );
    const messages: Message[] = [];
    await runTurn({
      userInput: 'think it through',
      history: [],
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'agent',
      onMessage: m => messages.push(m),
    });

    expect(messages.some(m => m.role === 'system' && m.content.includes('length ceiling'))).toBe(
      true,
    );
  });
});
