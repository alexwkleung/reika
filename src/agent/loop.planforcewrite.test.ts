import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// A plan-mode force-write the harness decided on (round ceiling, stall) used to be silent, and a
// length cut on the write round was then announced as "Still looping" — so a healthy exploration
// that ran long read as a model spiraling (observed on a 12-round API run, issue #265's plan).

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

const PRIOR = { ...process.env };
process.env.REIKA_VERBATIM_ABORT = '1';
process.env.REIKA_CONVERGE_RETRY = '1';
// The no-carry arm: a coherent draft cut on length is now carried forward (#572, covered in
// loop.planwritecarry.test.ts), and these pin the wording for the cuts that are not carried.
process.env.REIKA_CONTINUE = '0';
afterAll(() => {
  process.env = PRIOR;
});
const { runTurn } = await import('./loop.js');

// Distinct lines, so the repetition ratio stays far under the abort threshold: only the length
// ceiling can cut this block.
function healthy(n: number, seed = 0): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `step ${seed}-${i}: the line at index ${i + seed} ends at offset ${i * 7 + seed}, so the ` +
      `previous line starts after the newline at ${i * 7 - 1} and the walk continues to ` +
      `candidate ${i + 1 + seed}`,
  ).join('\n');
}

const readTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async args => ({
    summary: `Read ${String(args.path)}`,
    payload: `contents of ${args.path}`,
  }),
};

function readRound(path: string, n: number): ModelResponse {
  return { content: '', toolCalls: [{ id: `c${n}`, name: 'read', args: { path } }] };
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
    maxTurns: 20,
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
  };
}

async function runPlan(cwd: string): Promise<Message[]> {
  const messages: Message[] = [];
  await runTurn({
    userInput: 'plan it',
    history: [],
    bundle: makeBundle(cwd),
    config: makeConfig(),
    tools: [readTool],
    payloads: new PayloadStore(),
    promptMode: 'plan',
    onMessage: m => messages.push(m),
  });
  return messages;
}

function notices(messages: Message[]): string[] {
  return messages.flatMap(m => (m.role === 'system' ? [m.content] : []));
}

// Twelve rounds that each read a new file: never stale, so only the round ceiling ends exploration.
function exploreToCeiling(): void {
  for (let i = 0; i < 12; i++) {
    h.stream.push('');
    h.scripted.push(readRound(`src/f${i}.ts`, i));
  }
}

describe('plan force-write notices', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-planfw-'));
    h.stream.length = 0;
    h.scripted.length = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('announces a ceiling force-write once, before the plan', async () => {
    exploreToCeiling();
    h.stream.push('');
    h.scripted.push({ content: 'the plan', toolCalls: undefined });
    const messages = await runPlan(cwd);

    const announced = notices(messages).filter(n => n.startsWith('Explored for 12 rounds'));
    expect(announced).toHaveLength(1);
    const at = messages.findIndex(m => m.role === 'system' && m.content === announced[0]);
    const plan = messages.findIndex(m => m.role === 'assistant' && m.content === 'the plan');
    expect(at).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(at);
  });

  it('announces a stall force-write as a stall', async () => {
    for (let i = 0; i < 3; i++) {
      h.stream.push('');
      h.scripted.push(readRound('src/same.ts', i));
    }
    h.stream.push('');
    h.scripted.push({ content: 'the plan', toolCalls: undefined });
    const messages = await runPlan(cwd);

    expect(notices(messages).some(n => n.startsWith('Exploration stopped turning up'))).toBe(true);
    expect(notices(messages).some(n => n.startsWith('Explored for'))).toBe(false);
  });

  it('blames the length limit, not looping, when the write round is cut on length', async () => {
    exploreToCeiling();
    h.stream.push(healthy(120, 1), '');
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'the plan', toolCalls: undefined },
    );
    const messages = await runPlan(cwd);

    const all = notices(messages);
    expect(all.some(n => n.startsWith('The plan write hit the reasoning length limit'))).toBe(true);
    expect(all.some(n => n.startsWith('Still looping'))).toBe(false);
    expect(messages.some(m => m.role === 'assistant' && m.content === 'the plan')).toBe(true);
  });

  it('stops on the length diagnosis when the steered retry is cut on length too', async () => {
    exploreToCeiling();
    h.stream.push(healthy(120, 1), healthy(80, 2));
    h.scripted.push({ content: '', toolCalls: undefined }, { content: '', toolCalls: undefined });
    const messages = await runPlan(cwd);

    const stop = messages.filter(m => m.role === 'assistant').at(-1);
    const text = stop?.role === 'assistant' ? stop.content : '';
    expect(text).toContain('kept hitting the length limit');
    expect(text).not.toContain('kept looping');
  });
});
