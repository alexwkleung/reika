import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/types.js';
import {
  formatBenchTable,
  measureRequests,
  startMockModel,
  type MockModel,
  type RequestRow,
  type ScriptedReply,
} from './harnessbench.js';

// The bench measures reika's defaults, so nothing from the developer's shell may switch a flag:
// several modules read theirs at import time, hence the clear before the dynamic import below.
for (const key of Object.keys(process.env)) if (key.startsWith('REIKA_')) delete process.env[key];
const home = await mkdtemp(join(tmpdir(), 'reika-bench-home-'));
process.env.HOME = home;

// The web pair registers unless the machine is offline, and the tool list is request bytes.
vi.mock('../src/tools/_net.js', async importActual => ({
  ...(await importActual<object>()),
  isOffline: () => false,
}));

const { createSession } = await import('../src/session.js');

function moduleSource(name: string, steps: number): string {
  const fns = Array.from({ length: steps }, (_, i) =>
    [
      `export function ${name}Step${i}(input: number[]): number {`,
      `  // step ${i} of the ${name} pipeline folds its input into a running total`,
      `  return input.reduce((acc, value) => acc + value * ${i + 1}, ${i});`,
      `}`,
    ].join('\n'),
  );
  return [`// ${name}: generated fixture module`, ...fns].join('\n\n') + '\n';
}

// Six ~4KB modules and four ~1KB helpers. The stress scenario reads the big ones whole; the typical
// one mixes small files, line ranges and searches, the shape most real rounds take.
const FIXTURE: Record<string, string> = {
  ...Object.fromEntries(
    ['parser', 'lexer', 'render', 'config', 'cache', 'router'].map(name => [
      `src/${name}.ts`,
      moduleSource(name, 14),
    ]),
  ),
  ...Object.fromEntries(
    ['format', 'paths', 'errors', 'clock'].map(name => [
      `src/util/${name}.ts`,
      moduleSource(name, 3),
    ]),
  ),
};

const read = (path: string, offset?: number, limit?: number): ScriptedReply => ({
  toolCalls: [{ name: 'read', args: { path, ...(offset ? { offset, limit } : {}) } }],
});
const bash = (command: string): ScriptedReply => ({
  toolCalls: [{ name: 'bash', args: { command } }],
});
const grep = (pattern: string, path = 'src'): ScriptedReply => ({
  toolCalls: [{ name: 'grep', args: { pattern, path } }],
});
const edit = (path: string, old_string: string, new_string: string): ScriptedReply => ({
  toolCalls: [{ name: 'edit', args: { path, old_string, new_string } }],
});
const answer = (content: string): ScriptedReply => ({ content });

type Scenario = {
  name: string;
  window: number;
  // One entry per user turn; the model's script runs across them in order, each turn ending on an
  // answer with no calls.
  prompts: string[];
  script: ScriptedReply[];
  snapshot: string;
  // Stress must reach the edge or it measures nothing; typical must never get there.
  shrinks: boolean;
};

// The extreme end on purpose: a 12k window where every read is a tenth of it, so a short session
// sheds and folds several times. It pins the machinery that runs at the edge, and its numbers are
// not what a typical session costs.
const STRESS: Scenario = {
  name: 'stress: 12k window, whole-file reads',
  window: 12_000,
  prompts: [
    'Look through the pipeline modules and fix the seed of parserStep0.',
    'Now summarize how render.ts composes its steps.',
  ],
  script: [
    read('src/parser.ts'),
    read('src/lexer.ts'),
    grep('Step3'),
    read('src/render.ts'),
    read('src/config.ts'),
    bash('ls src'),
    read('src/cache.ts'),
    read('src/router.ts'),
    read('src/parser.ts'),
    edit('src/parser.ts', 'acc + value * 1, 0', 'acc + value * 1, 1'),
    bash('cat src/missing.ts'),
    read('src/lexer.ts'),
    answer('Changed the seed of parserStep0 from 0 to 1.'),
    read('src/render.ts'),
    grep('running total'),
    answer('render.ts has 14 steps, each folding with its index as the seed.'),
  ],
  snapshot: 'harnessbench.stress.snapshot.txt',
  shrinks: true,
};

// The common case: a 32k window, three turns of mixed small reads, ranges, searches and edits. It
// should stay append-only throughout, so a rewrite or a shrink showing up here is a regression in
// the path most sessions take.
const TYPICAL: Scenario = {
  name: 'typical: 32k window, mixed session',
  window: 32_000,
  prompts: [
    'The clock helper should seed from 1. Fix it and check nothing else depends on the old seed.',
    'Also rename formatStep2 to formatTotal.',
    'Which helpers does the router use?',
  ],
  script: [
    grep('clockStep'),
    read('src/util/clock.ts'),
    edit('src/util/clock.ts', 'acc + value * 1, 0', 'acc + value * 1, 1'),
    grep('clockStep0'),
    bash('cat src/util/clock.ts | head -5'),
    answer('clockStep0 now seeds from 1; nothing else references it.'),
    grep('formatStep2'),
    read('src/util/format.ts'),
    edit('src/util/format.ts', 'function formatStep2(', 'function formatTotal('),
    grep('formatStep2'),
    answer('Renamed formatStep2 to formatTotal; it had no other callers.'),
    bash('ls src src/util'),
    read('src/router.ts', 1, 20),
    grep('util', 'src/router.ts'),
    read('src/util/paths.ts'),
    read('src/router.ts', 20, 20),
    read('src/util/errors.ts'),
    answer('The router imports none of the helpers; each module is self-contained.'),
  ],
  snapshot: 'harnessbench.typical.snapshot.txt',
  shrinks: false,
};

const NOTE = 'Findings: pipeline modules with indexed steps; the edits so far are recorded above.';

function scriptedModel(
  script: ScriptedReply[],
): (body: { tool_choice?: unknown }) => ScriptedReply {
  let step = 0;
  return body => {
    if (body.tool_choice === 'none') return { content: NOTE };
    const next = script[step] ?? answer('done');
    step++;
    return { reasoning: `Round ${step}: checking how the steps compose before acting.`, ...next };
  };
}

function benchConfig(baseURL: string, window: number): Config {
  const profile = {
    model: 'bench',
    baseURL,
    apiKey: 'x',
    contextWindow: window,
    maxOutputTokens: 4096,
  };
  return {
    ...profile,
    models: ['bench'],
    maxTurns: 40,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: { default: profile },
    minGenTokens: 1024,
    reasoningRounds: 2,
    maxSearchesPerTurn: 3,
    maxFetchesPerTurn: 3,
    bashTimeoutMs: 10_000,
    bashIdleMs: 10_000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
    typecheck: false,
  };
}

type BenchRun = { rows: RequestRow[]; shrink: { sheds: number; folds: number } };

async function runScenario(scenario: Scenario): Promise<BenchRun> {
  const cwd = await mkdtemp(join(tmpdir(), 'reika-bench-'));
  let model: MockModel | undefined;
  try {
    for (const [path, source] of Object.entries(FIXTURE)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), source);
    }
    model = await startMockModel(scriptedModel(scenario.script));
    const config = benchConfig(model.baseURL, scenario.window);
    const session = await createSession({ cwd, config, canAsk: false });
    for (const prompt of scenario.prompts) await session.submit(prompt, { mode: 'agent' });
    // The temp dir's name differs per run and per machine; its length must not move the numbers.
    const rows = measureRequests(model.requests, s => s.split(cwd).join('<cwd>'));
    return { rows, shrink: { ...session.shrink } };
  } finally {
    await model?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

const rewrites = (rows: RequestRow[]): RequestRow[] =>
  rows.filter(r => r.divergence === 'mid-history' || r.divergence === 'system-changed');

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe.each([STRESS, TYPICAL])('harness-cost bench — $name', scenario => {
  let run: BenchRun;
  beforeAll(async () => {
    run = await runScenario(scenario);
  }, 60_000);

  it('matches the recorded request shape', async () => {
    await expect(formatBenchTable(run.rows, run.shrink)).toMatchFileSnapshot(scenario.snapshot);
  });

  // Prefix-stable's promise: between shrink events requests only grow at the end. A rewrite above
  // the tail is a full re-prefill on a real engine, and each one has to be paid for by an event.
  it('rewrites history no more often than it shrinks', () => {
    expect(rewrites(run.rows).length).toBeLessThanOrEqual(run.shrink.sheds + run.shrink.folds);
  });

  it('never changes the tool list mid-session', () => {
    expect(run.rows.filter(r => r.divergence === 'tools-changed')).toEqual([]);
  });

  it(scenario.shrinks ? 'reaches a shrink event' : 'never shrinks or rewrites history', () => {
    const events = run.shrink.sheds + run.shrink.folds;
    if (scenario.shrinks) expect(events).toBeGreaterThan(0);
    else expect({ events, rewrites: rewrites(run.rows) }).toEqual({ events: 0, rewrites: [] });
  });
});
