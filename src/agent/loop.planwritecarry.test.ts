import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The plan write's 12k reasoning ceiling discarded a coherent draft (ratio 0.00) 256 chars over the
// line, and the restart re-prefilled the whole request twice. A low-ratio length cut on the write
// round is now carried forward; a block in the low-ratio spiral band (~0.3) the ceiling exists for
// is still discarded.

const h = vi.hoisted(() => ({
  stream: [] as string[],
  scripted: [] as ModelResponse[],
  calls: [] as { system: string; history: Message[]; tools: unknown[] }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(
    async (opts: {
      system: string;
      history: Message[];
      tools: unknown[];
      onReasoningDelta?: (t: string) => void;
    }) => {
      h.calls.push({ system: opts.system, history: [...opts.history], tools: opts.tools });
      const chunk = h.stream.shift();
      if (chunk) {
        for (let i = 0; i < chunk.length; i += 1000)
          opts.onReasoningDelta?.(chunk.slice(i, i + 1000));
      }
      return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
    },
  ),
}));

const PRIOR = { ...process.env };
process.env.REIKA_VERBATIM_ABORT = '1';
process.env.REIKA_CONVERGE_RETRY = '1';
process.env.REIKA_CONTINUE = '1';
afterAll(() => {
  process.env = PRIOR;
});
const { runTurn } = await import('./loop.js');

function healthy(n: number, seed = 0): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `step ${seed}-${i}: the line at index ${i + seed} ends at offset ${i * 7 + seed}, so the ` +
      `previous line starts after the newline at ${i * 7 - 1} and the walk continues to ` +
      `candidate ${i + 1 + seed}`,
  ).join('\n');
}

// Letters only: the shingler normalizes digits away, so numbered tokens would all read as one word.
function letters(n: number): string {
  let out = '';
  for (let k = n + 1; k > 0; k = Math.floor(k / 26)) out += String.fromCharCode(97 + (k % 26));
  return out;
}

// Every word unique to its seed, so separate rounds of a long draft share no 8-grams — which
// real prose across continuations mostly does not either, unlike the fixed template in healthy().
function distinct(n: number, seed: number): string {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: 14 }, (_, j) => letters(seed * 100_000 + i * 100 + j)).join(' '),
  ).join('\n');
}

// Restates its own opening: ~0.22 at the 12k cut, under the 0.35 abort curve at every check, so
// only the length ceiling fires — the low-ratio spiral the write round's ceiling is there to catch.
function circling(): string {
  return `${healthy(70, 1)}\n${healthy(70, 1)}`;
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
    maxTurns: 25,
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

// Twelve rounds reading a new file each: only the round ceiling ends exploration.
function exploreToCeiling(): void {
  for (let i = 0; i < 12; i++) {
    h.stream.push('');
    h.scripted.push({
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'read', args: { path: `src/f${i}.ts` } }],
    });
  }
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

describe('plan write length carry', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-planwrite-'));
    h.stream.length = 0;
    h.scripted.length = 0;
    h.calls.length = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('carries a coherent draft forward as an append to the same write request', async () => {
    exploreToCeiling();
    const draft = healthy(120, 1);
    h.stream.push(draft, '');
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'the plan', toolCalls: undefined },
    );
    const messages = await runPlan(cwd);

    expect(notices(messages).some(n => n.startsWith('Plan write hit the length ceiling'))).toBe(
      true,
    );
    expect(notices(messages).some(n => n.includes('tighter steer'))).toBe(false);
    expect(messages.some(m => m.role === 'assistant' && m.content === 'the plan')).toBe(true);

    const [first, second] = h.calls.slice(12);
    // Same system and same synthetic message: the carry is a pure append, no re-prefill.
    expect(second.system).toBe(first.system);
    expect(second.history[0]).toEqual(first.history[0]);
    expect(first.history).toHaveLength(1);
    expect(second.history).toHaveLength(3);
    const tail = second.history[1];
    expect(tail.role).toBe('assistant');
    // The draft is cut at the ceiling, so the tail ends where that cut landed.
    expect(tail.role === 'assistant' && draft.startsWith(tail.content.slice(-500))).toBe(false);
    expect(tail.role === 'assistant' && tail.content.length).toBeGreaterThan(1000);
    const nudge = second.history[2];
    expect(nudge.role === 'user' && nudge.content).toContain('write the numbered plan');
  });

  it('still discards a draft in the low-ratio spiral band', async () => {
    exploreToCeiling();
    h.stream.push(circling(), '');
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'the plan', toolCalls: undefined },
    );
    const messages = await runPlan(cwd);

    expect(notices(messages).some(n => n.startsWith('Plan write hit the length ceiling'))).toBe(
      false,
    );
    expect(notices(messages).some(n => n.includes('tighter steer'))).toBe(true);
    const retry = h.calls.at(-1)!;
    expect(retry.history).toHaveLength(1);
  });

  it('drops the carry when a continued round turns into a spiral', async () => {
    exploreToCeiling();
    h.stream.push(healthy(120, 1), circling(), '');
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: '', toolCalls: undefined },
      { content: 'the plan', toolCalls: undefined },
    );
    const messages = await runPlan(cwd);

    expect(notices(messages).some(n => n.includes('tighter steer'))).toBe(true);
    expect(messages.some(m => m.role === 'assistant' && m.content === 'the plan')).toBe(true);
    // The steered retry starts the write over: no tail from the discarded draft rides along.
    expect(h.calls.at(-1)!.history).toHaveLength(1);
  });

  it('stops carrying after the ladder budget and falls through to the steered retry', async () => {
    exploreToCeiling();
    // Three carries (REIKA_CONTINUE_MAX default), a fourth cut refused on count, then the steered
    // retry — which never carries, since it is the last attempt.
    for (let k = 0; k < 5; k++) h.stream.push(distinct(200, k + 1));
    for (let k = 0; k < 5; k++) h.scripted.push({ content: '', toolCalls: undefined });
    const messages = await runPlan(cwd);

    const carried = notices(messages).filter(n =>
      n.startsWith('Plan write hit the length ceiling'),
    );
    expect(carried).toHaveLength(3);
    expect(notices(messages).some(n => n.includes('tighter steer'))).toBe(true);
    expect(h.calls.at(-1)!.history).toHaveLength(1);
  });
});
