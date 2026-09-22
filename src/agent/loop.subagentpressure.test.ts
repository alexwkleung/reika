import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { grepTool } from '../tools/grep.js';
import { readTool } from '../tools/read.js';
import { subagentTool } from '../tools/subagent.js';

// #343 through the real runTurn and the real grep tool: a result spanning enough files, on a window
// small enough that reading them would cross the compaction threshold, gets the subagent footer —
// once per turn, only with the flag, only when the subagent tool is in the list.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));
const { runTurn } = await import('./loop.js');

const grep = (id: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id, name: 'grep', args: { pattern: 'needle', path: '.' } }],
});
const final = (content: string): ModelResponse => ({ content, toolCalls: undefined });

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

// 12k window: threshold ≈ 9.9k tokens, so even a tiny estimate plus four forecast reads (10k)
// is over it — the pressure condition holds from round 0.
function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 10,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 3,
    profiles: {},
    contextWindow: 12000,
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

describe('subagent pressure affordance (#343)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-pressure-'));
    for (const f of ['a', 'b', 'c', 'd', 'e']) {
      await writeFile(join(cwd, `${f}.ts`), `export const ${f} = 'needle';\n`, 'utf8');
    }
    h.scripted.length = 0;
  });
  afterEach(async () => {
    delete process.env.REIKA_SUBAGENT_PRESSURE;
    await rm(cwd, { recursive: true, force: true });
  });

  const run = async (tools = [readTool, grepTool, subagentTool]) => {
    const history: Message[] = [];
    await runTurn({
      userInput: 'find needle',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools,
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    return history.filter(m => m.role === 'tool') as (Message & { role: 'tool' })[];
  };

  it('appends the footer to a grep result spanning enough files under pressure, once per turn', async () => {
    process.env.REIKA_SUBAGENT_PRESSURE = '1';
    h.scripted.push(grep('g1'), grep('g2'), final('done'));
    const tools = await run();
    expect(tools).toHaveLength(2);
    expect(tools[0].summary).toContain('Found 5 matches');
    expect(tools[0].payload).toContain('5 files match');
    expect(tools[0].payload).toContain('Hand the list to subagent');
    expect(tools[0].payload!.trimEnd().endsWith(')')).toBe(true);
    expect(tools[1].payload).not.toContain('files match');
  });

  it('is a strict no-op with the flag off', async () => {
    process.env.REIKA_SUBAGENT_PRESSURE = '0';
    h.scripted.push(grep('g1'), final('done'));
    const tools = await run();
    expect(tools[0].payload).not.toContain('files match');
  });

  it('says nothing when the subagent tool is not in the list', async () => {
    process.env.REIKA_SUBAGENT_PRESSURE = '1';
    h.scripted.push(grep('g1'), final('done'));
    const tools = await run([readTool, grepTool]);
    expect(tools[0].payload).not.toContain('files match');
  });
});
