import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// #247: a fold's recap has never been readable after the fact. It is spliced into the model history
// per turn, while the saved transcript is written from the UI scrollback — so across 39 saved
// transcripts there is not one `compaction` row, even for runs whose debug log recorded
// `compaction removed=12`. The only trace of a fold anywhere was a count, which makes "the model got
// confused after a fold" impossible to check against the recap that caused it, and would make any
// improvement to buildRecap unmeasurable.
const PRIOR: Record<string, string | undefined> = {};
for (const k of ['REIKA_DEBUG', 'REIKA_DEBUG_FILE']) PRIOR[k] = process.env[k];
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  for (const [k, v] of Object.entries(PRIOR)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

const noopTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Enough prior turns, each carrying a real payload, that the fold has something to summarize.
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
    // Assistant content, not the payload, is what carries the weight: a non-fresh tool message
    // estimates by its summary alone, so seeding big payloads would never cross the threshold.
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(3000)}` });
  }
  return out;
}

describe('compaction recap is logged, not just counted (#247)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-recaplog-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the recap text a model actually received, matching the spliced message', async () => {
    h.scripted.push({ content: 'final', toolCalls: undefined });
    const history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });

    const log = await readFile(logPath, 'utf8');
    // The fold really happened — otherwise this test would pass for the wrong reason.
    const countLine = log.split('\n').find(l => l.includes('compaction removed='));
    expect(countLine).toBeDefined();
    expect(countLine).toMatch(/removed=[1-9]\d*/);
    expect(countLine).toMatch(/recap=\d+c/);

    // Reassemble what was logged and compare against the message that was actually spliced into the
    // history. A log of a recap that is not the recap would look right and be worthless.
    const logged = log
      .split('\n')
      .filter(l => l.includes('] compaction-recap round='))
      .map(l => l.slice(l.indexOf(' | ') + 3))
      .join('\n');
    const spliced = history.find(m => m.role === 'compaction');
    expect(spliced).toBeDefined();
    expect(logged).toBe((spliced as Message & { role: 'compaction' }).content);
    expect(logged.length).toBeGreaterThan(0);
  });
});
