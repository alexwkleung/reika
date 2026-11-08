import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Usage } from '../types.js';
import type { LiveUsage } from './liveusage.js';

// The running figures for a request in flight (#925) are display only: reported as the request goes
// out, cleared before the real count lands, and invisible to everything that learns.
const h = vi.hoisted(() => ({
  responses: [] as ModelResponse[],
  output: 'x'.repeat(4000),
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onOutputDelta?: (t: string) => void }) => {
    opts.onOutputDelta?.(h.output);
    return h.responses.shift() ?? { content: 'done', finishReason: 'stop' };
  }),
}));

const { runTurn } = await import('./loop.js');

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

type Event = LiveUsage | 'cleared' | Usage;

async function run(extra: { onCalibration?: (f: number) => void } = {}) {
  const events: Event[] = [];
  const history: Message[] = [];
  await runTurn({
    userInput: 'hello',
    history,
    bundle,
    config,
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    onLiveUsage: live => events.push(live ?? 'cleared'),
    onUsage: u => events.push(u),
    ...extra,
  });
  return events;
}

describe('live usage in the loop (#925)', () => {
  beforeEach(() => {
    h.responses = [];
  });

  it('reports at send, then clears ahead of the real count', async () => {
    const real: Usage = { promptTokens: 900, completionTokens: 1000 };
    h.responses = [{ content: 'done', finishReason: 'stop', usage: real }];
    const events = await run();
    expect(events[0]).toMatchObject({ completionTokens: 0 });
    expect((events[0] as LiveUsage).promptTokens).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({ completionTokens: 1000 });
    expect(events.at(-2)).toBe('cleared');
    expect(events.at(-1)).toBe(real);
  });

  it('leaves calibration to the real count', async () => {
    h.responses = [{ content: 'done', finishReason: 'stop' }];
    const onCalibration = vi.fn();
    await run({ onCalibration });
    expect(onCalibration).not.toHaveBeenCalled();
  });
});
