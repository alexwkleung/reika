import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const WINDOW = 12_000;

// Six modules of ~4KB: big enough that a handful of reads crosses the threshold on a 12k window,
// which is what forces the shed and the fold the bench exists to watch.
function moduleSource(name: string): string {
  const fns = Array.from({ length: 14 }, (_, i) =>
    [
      `export function ${name}Step${i}(input: number[]): number {`,
      `  // step ${i} of the ${name} pipeline folds its input into a running total`,
      `  return input.reduce((acc, value) => acc + value * ${i + 1}, ${i});`,
      `}`,
    ].join('\n'),
  );
  return [`// ${name}: generated fixture module`, ...fns].join('\n\n') + '\n';
}

const MODULES = ['parser', 'lexer', 'render', 'config', 'cache', 'router'];

const read = (path: string): ScriptedReply => ({ toolCalls: [{ name: 'read', args: { path } }] });
const bash = (command: string): ScriptedReply => ({
  toolCalls: [{ name: 'bash', args: { command } }],
});
const thinking = (n: number): string =>
  `Round ${n}: checking how the pipeline steps compose before changing anything.`;

// One scripted session: an exploration-heavy first turn with an edit and a failing command, then a
// short follow-up turn, so the turn boundary is measured too.
const SCRIPT: ScriptedReply[] = [
  read('src/parser.ts'),
  read('src/lexer.ts'),
  { toolCalls: [{ name: 'grep', args: { pattern: 'Step3', path: 'src' } }] },
  read('src/render.ts'),
  read('src/config.ts'),
  bash('ls src'),
  read('src/cache.ts'),
  read('src/router.ts'),
  read('src/parser.ts'),
  {
    toolCalls: [
      {
        name: 'edit',
        args: {
          path: 'src/parser.ts',
          old_string: 'acc + value * 1, 0',
          new_string: 'acc + value * 1, 1',
        },
      },
    ],
  },
  bash('cat src/missing.ts'),
  read('src/lexer.ts'),
  { content: 'Changed the seed of parserStep0 from 0 to 1.' },
  read('src/render.ts'),
  { toolCalls: [{ name: 'grep', args: { pattern: 'running total', path: 'src' } }] },
  { content: 'render.ts has 14 steps, each folding with its index as the seed.' },
];

const NOTE = 'Findings: six pipeline modules, 14 steps each; parserStep0 seed changed to 1.';

function scriptedModel(): (body: { tool_choice?: unknown }) => ScriptedReply {
  let step = 0;
  return body => {
    if (body.tool_choice === 'none') return { content: NOTE };
    const next = SCRIPT[step] ?? { content: 'done' };
    step++;
    return { reasoning: thinking(step), ...next };
  };
}

function benchConfig(baseURL: string): Config {
  const profile = {
    model: 'bench',
    baseURL,
    apiKey: 'x',
    contextWindow: WINDOW,
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

describe('harness-cost bench: scripted agent session on a 12k window', () => {
  let cwd: string;
  let model: MockModel;
  let rows: RequestRow[];
  let shrink: { sheds: number; folds: number };

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-bench-'));
    await mkdir(join(cwd, 'src'));
    for (const name of MODULES) await writeFile(join(cwd, 'src', `${name}.ts`), moduleSource(name));
    model = await startMockModel(scriptedModel());
    const session = await createSession({ cwd, config: benchConfig(model.baseURL), canAsk: false });
    await session.submit('Look through the pipeline modules and fix the seed of parserStep0.', {
      mode: 'agent',
    });
    await session.submit('Now summarize how render.ts composes its steps.', { mode: 'agent' });
    shrink = session.shrink;
    // The temp dir's name differs per run and per machine; its length must not move the numbers.
    rows = measureRequests(model.requests, s => s.split(cwd).join('<cwd>'));
  }, 60_000);

  afterAll(async () => {
    await model?.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('matches the recorded request shape', async () => {
    await expect(formatBenchTable(rows, shrink)).toMatchFileSnapshot('harnessbench.snapshot.txt');
  });

  it('forces at least one shrink event, or the bench measures nothing', () => {
    expect(shrink.sheds + shrink.folds).toBeGreaterThan(0);
  });

  // Prefix-stable's promise: between shrink events requests only grow at the end. A rewrite above
  // the tail is a full re-prefill on a real engine, and each one has to be paid for by an event.
  it('rewrites history no more often than it shrinks', () => {
    const rewrites = rows.filter(
      r => r.divergence === 'mid-history' || r.divergence === 'system-changed',
    );
    expect(rewrites.length).toBeLessThanOrEqual(shrink.sheds + shrink.folds);
  });

  it('never changes the tool list mid-session', () => {
    expect(rows.filter(r => r.divergence === 'tools-changed')).toEqual([]);
  });
});
