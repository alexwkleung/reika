import { tmpdir } from 'node:os';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Usage } from '../types.js';
import { GenReserve } from './genreserve.js';

// A stream cut short never reaches its usage chunk (#906): the round is counted from what streamed,
// marked as an estimate, and none of the learners may see it.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  stream: [] as string[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onReasoningDelta?: (t: string) => void }) => {
    const chunk = h.stream.shift();
    if (chunk) {
      for (let i = 0; i < chunk.length; i += 1000)
        opts.onReasoningDelta?.(chunk.slice(i, i + 1000));
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined, finishReason: 'stop' };
  }),
}));

const PRIOR_CONTINUE = process.env.REIKA_CONTINUE;
const PRIOR_ABORT = process.env.REIKA_VERBATIM_ABORT;
process.env.REIKA_CONTINUE = '1';
process.env.REIKA_VERBATIM_ABORT = '1';
afterAll(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('REIKA_CONTINUE', PRIOR_CONTINUE);
  restore('REIKA_VERBATIM_ABORT', PRIOR_ABORT);
});

const { runTurn } = await import('./loop.js');

// Past REASONING_HARD_CEIL (32000 chars) at a low repeat ratio: the ceiling cuts it.
const thought = Array.from(
  { length: 300 },
  (_, i) =>
    `step ${i}: the line at index ${i} ends at offset ${i * 7}, so the previous line starts ` +
    `after the newline at ${i * 7 - 1} and the walk continues from there to candidate ${i + 1}`,
).join('\n');
// One sentence over and over: the ratio trips.
const spiral = Array(300)
  .fill('the previous line starts at the index after the newline that terminates it')
  .join('\n');

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
  hash: 'test',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'bypass',
  subagentMaxTurns: 5,
  profiles: {},
  contextWindow: 64_000,
  minGenTokens: 2048,
  minGenAdaptive: true,
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

async function turn(extra: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const usage: Usage[] = [];
  const calibration: number[] = [];
  const decode: (number | undefined)[] = [];
  const history: Message[] = [];
  await runTurn({
    userInput: 'go',
    history,
    bundle,
    config,
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    onUsage: u => usage.push(u),
    onCalibration: f => calibration.push(f),
    onDecodeRate: r => decode.push(r),
    ...extra,
  });
  return { usage, calibration, decode };
}

// A cut stream as callModel returns it: what arrived, with timing, and no usage.
const cutRound = (reasoning: string): ModelResponse => ({
  content: '',
  reasoning,
  toolCalls: undefined,
  timing: { ttftMs: 100, totalMs: 60_000 },
});

describe('usage of a round cut short (#906)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.stream.length = 0;
  });

  it('counts a ceiling cut from what streamed, marked as an estimate', async () => {
    h.stream.push(thought);
    h.scripted.push(cutRound(thought));
    const { usage } = await turn();
    const estimated = usage.find(u => u.estimated);
    expect(estimated?.completionTokens).toBe(Math.ceil(thought.length / 4));
    expect(estimated?.promptTokens).toBeGreaterThan(0);
    expect(estimated?.cachedTokens).toBeUndefined();
  });

  it('counts a ratio cut the same way', async () => {
    h.stream.push(spiral);
    h.scripted.push(cutRound(spiral));
    const { usage } = await turn();
    expect(usage.find(u => u.estimated)?.completionTokens).toBe(Math.ceil(spiral.length / 4));
  });

  it('counts a ctrl-c mid-stream, content included', async () => {
    const abort = new AbortController();
    h.scripted.push({ content: 'partial', reasoning: 'thinking', toolCalls: undefined });
    h.stream.push('x');
    const { usage } = await turn({
      signal: abort.signal,
      onReasoningDelta: () => abort.abort(),
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ estimated: true, completionTokens: Math.ceil(15 / 4) });
  });

  it('counts nothing for a cut before any output, since nothing was decoded', async () => {
    const abort = new AbortController();
    abort.abort();
    h.scripted.push({ content: '', toolCalls: undefined });
    const { usage } = await turn({ signal: abort.signal });
    expect(usage).toEqual([]);
  });

  it('keeps calibration, the decode rate and the reserve off the estimate', async () => {
    const reserve = new GenReserve();
    h.stream.push(spiral);
    h.scripted.push(cutRound(spiral));
    const { calibration, decode } = await turn({ genReserve: reserve });
    expect(calibration).toEqual([]);
    expect(decode).toEqual([]);
    expect(reserve.learned(0)).toBeUndefined();
  });

  it('passes a reported count through unmarked, even on a cut stream', async () => {
    const reported = { promptTokens: 900, completionTokens: 40 };
    h.stream.push(spiral);
    h.scripted.push({ ...cutRound(spiral), usage: reported });
    const { usage } = await turn();
    expect(usage[0]).toEqual(reported);
  });

  it('does not estimate a finished round whose provider reports no usage', async () => {
    h.scripted.push({ content: 'answer', toolCalls: undefined, finishReason: 'stop' });
    const { usage } = await turn();
    expect(usage).toEqual([]);
  });
});
