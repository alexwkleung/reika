import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// End-to-end wiring for the prefill-cost annotation (issue #195): the `prefix-cache` line has to
// carry what the divergence cost, and a round that paid for a prefill has to teach the rate the
// NEXT round quotes. Same harness shape as loop.entropy.test.ts — debug flags before the import,
// log pointed at a temp file per test.
const PRIOR_DEBUG = process.env.REIKA_DEBUG;
const PRIOR_FILE = process.env.REIKA_DEBUG_FILE;
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('REIKA_DEBUG', PRIOR_DEBUG);
  restore('REIKA_DEBUG_FILE', PRIOR_FILE);
});

// The loop measures divergence on whatever callModel hands its onRequest hook, so the mock scripts
// the serialized requests directly — this is a test of the loop's accounting, not of toolcall.ts.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  requests: [] as { role: string; content: string }[][],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onRequest?: (m: unknown[]) => void }) => {
    const msgs = h.requests.shift();
    if (msgs) opts.onRequest?.(msgs);
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

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

const noopTool: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

const callNoop = { id: 'n1', name: 'noop', args: {} };

// The reprocessed-token count is the round's real prompt estimate scaled by the unstable char
// fraction, so BOTH have to be big: a long user turn to make the estimate clear PrefillRate's
// minimum sample size, and a long scripted system message so an append leaves most of it stable.
const bigSystem = { role: 'system', content: 'S'.repeat(60_000) };
const bigInput = 'analyze the composer component and the props it forwards. '.repeat(800);
const num = (line: string, key: string): number =>
  Number(new RegExp(`${key}[=\u2264]([\\d.]+)`).exec(line)![1]);

describe('prefill-cost annotation on the prefix-cache line (integration)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-prefill-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
    h.requests.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(input = bigInput): Promise<string[]> {
    const history: Message[] = [];
    await runTurn({
      userInput: input,
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    const log = await readFile(logPath, 'utf8');
    return log.split('\n').filter(l => l.includes('] prefix-cache round='));
  }

  it('prices a round that reprocessed the whole prompt, and marks the rate unlearned', async () => {
    h.requests.push([bigSystem, { role: 'user', content: bigInput }]);
    h.scripted.push({ content: 'done', toolCalls: undefined });

    const [line] = await run();
    expect(line).toContain('cause=first-request');
    expect(num(line!, 'reprocess')).toBeGreaterThan(512);
    // No baseline on a turn's first request: a ceiling, said with \u2264, not an `=` measurement.
    expect(line).toContain('reprocess\u2264');
    // Nothing has been observed yet — `?`, never a silently missing field.
    expect(line).toContain('est\u2264? rate=?');
  });

  it('learns the rate from the round that paid, and quotes it on the next one', async () => {
    const first = [bigSystem, { role: 'user', content: bigInput }];
    // Round 1 rewrites the system block (compaction/ledger shape): a real, measured re-process of
    // the whole prompt — unlike round 0, which only has a ceiling.
    const rewritten = [{ role: 'system', content: 'X'.repeat(60_000) }, ...first.slice(1)];
    h.requests.push(first, rewritten, [...rewritten, { role: 'tool', content: 'ok' }]);
    h.scripted.push(
      { content: '', toolCalls: [callNoop] },
      { content: '', toolCalls: [callNoop], timing: { ttftMs: 10_000, totalMs: 12_000 } },
      { content: 'done', toolCalls: undefined },
    );

    const lines = await run();
    expect(lines).toHaveLength(3);

    // Round 1 re-processed its whole prompt over 10 s; round 2 must price itself at that rate.
    expect(lines[1]).toContain('cause=system-changed');
    expect(num(lines[2]!, 'rate')).toBeCloseTo(num(lines[1]!, 'reprocess') / 10, 0);
    expect(lines[2]).not.toContain('est=?');
  });

  // The trace is turn-scoped, so round 0 has nothing to diverge from — its full-prompt count is a
  // ceiling. Learning a rate from it would price every later round against an inflated numerator.
  it('does not learn a rate from the unmeasured first request', async () => {
    const first = [bigSystem, { role: 'user', content: bigInput }];
    h.requests.push(first, [...first, { role: 'tool', content: 'ok' }]);
    h.scripted.push(
      { content: '', toolCalls: [callNoop], timing: { ttftMs: 10_000, totalMs: 12_000 } },
      { content: 'done', toolCalls: undefined },
    );

    const lines = await run();
    expect(lines[1]).toContain('cause=append-only');
    expect(lines[1]).toContain('rate=?');
  });

  // TTFT on a round that reprocessed a short appended tail is mostly per-request overhead, not
  // prefill — learning from it would misprice the expensive rounds that matter.
  it('does not learn a rate from a round that reprocessed almost nothing', async () => {
    const first = [bigSystem, { role: 'user', content: bigInput }];
    const second = [...first, { role: 'tool', content: 'ok' }];
    h.requests.push(first, second, [...second, { role: 'tool', content: 'ok again' }]);
    h.scripted.push(
      // No timing on the expensive round: nothing to learn from it either.
      { content: '', toolCalls: [callNoop] },
      { content: '', toolCalls: [callNoop], timing: { ttftMs: 2_000, totalMs: 3_000 } },
      { content: 'done', toolCalls: undefined },
    );

    const lines = await run();
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('cause=append-only');
    expect(num(lines[1]!, 'reprocess')).toBeGreaterThan(0);
    expect(num(lines[1]!, 'reprocess')).toBeLessThan(512);
    expect(lines[2]).toContain('est=? rate=?');
  });
});
