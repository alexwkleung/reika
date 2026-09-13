import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { readTool } from '../tools/read.js';
import { subagentTool } from '../tools/subagent.js';
import { MAX_SUBAGENTS_PER_TURN, SUBAGENT_REPORT_DIRECTIVE } from './subagentreport.js';

// Subagent bounded return (#340), driven through the real runTurn with a scripted model: the last
// budgeted round of a subagent carries no tools and the report directive, its in-band tool calls
// are dropped, its reply is the digest the parent receives, and the digest carries the coverage
// note for what the task named but the subagent never read.

type Captured = { system: string; tools: Tool[]; trailingNote?: string; history: Message[] };
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as {
    system: string;
    tools: { name: string }[];
    trailingNote?: string;
    historyLen: number;
  }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: Captured) => {
    h.captured.push({
      system: opts.system,
      tools: opts.tools.map(t => ({ name: t.name })),
      trailingNote: opts.trailingNote,
      historyLen: opts.history.length,
    });
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

const readResponse = (path: string, id = 'r1'): ModelResponse => ({
  content: '',
  toolCalls: [{ id, name: 'read', args: { path } }],
});
const subagentResponse = (task: string, id = 's1'): ModelResponse => ({
  content: '',
  toolCalls: [{ id, name: 'subagent', args: { task } }],
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

function makeConfig(over: Partial<Config> = {}): Config {
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
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
    ...over,
  };
}

describe('subagent bounded return (#340)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-subreport-'));
    await writeFile(join(cwd, 'a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(cwd, 'b.ts'), 'export const b = 2;\n', 'utf8');
    h.scripted.length = 0;
    h.captured.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('withdraws every tool and sends the directive on the last budgeted round, and the reply is final', async () => {
    const history: Message[] = [];
    // Round 0: read. Round 1: read. Round 2 (cap−1): the model still tries to read in-band; the
    // call is dropped and the content becomes the report.
    h.scripted.push(readResponse('a.ts'), readResponse('b.ts', 'r2'), {
      content: 'Report: a then b.\nNot covered: c.ts',
      toolCalls: [{ id: 'r3', name: 'read', args: { path: 'c.ts' } }],
    });
    await runTurn({
      userInput: 'trace a.ts and b.ts and c.ts',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig({ maxTurns: 3 }),
      tools: [readTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      reportAtCap: true,
    });
    expect(h.captured).toHaveLength(3);
    // Earlier rounds: tools offered, no directive.
    expect(h.captured[0].tools.map(t => t.name)).toEqual(['read']);
    expect(h.captured[0].system + (h.captured[0].trailingNote ?? '')).not.toContain(
      SUBAGENT_REPORT_DIRECTIVE,
    );
    // Report round: no tools, directive present (system suffix or tail note, whichever channel).
    expect(h.captured[2].tools).toEqual([]);
    expect(h.captured[2].system + (h.captured[2].trailingNote ?? '')).toContain(
      SUBAGENT_REPORT_DIRECTIVE,
    );
    // The in-band read on the report round was dropped; the turn ended on the report, not on the
    // honest-exhaustion message.
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Report: a then b.');
    expect(last.toolCalls).toBeUndefined();
    expect(
      history.some(m => m.role === 'assistant' && m.content.includes('reached max turns')),
    ).toBe(false);
  });

  it('falls back to the reasoning channel when the report round has no content', async () => {
    const history: Message[] = [];
    h.scripted.push(readResponse('a.ts'), {
      content: '',
      reasoning: 'a is 1, b unread',
      toolCalls: undefined,
    });
    await runTurn({
      userInput: 'trace',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig({ maxTurns: 2 }),
      tools: [readTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      reportAtCap: true,
    });
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.content).toBe('a is 1, b unread');
  });

  it('leaves the parent turn alone: without reportAtCap the cap still ends in the exhaustion message', async () => {
    const history: Message[] = [];
    h.scripted.push(readResponse('a.ts'), readResponse('b.ts', 'r2'));
    await runTurn({
      userInput: 'trace',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig({ maxTurns: 2 }),
      tools: [readTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    expect(h.captured[1].tools.map(t => t.name)).toEqual(['read']);
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.content).toContain('reached max turns');
  });

  it('hands the parent the report plus a coverage note for what the task named but the subagent never read', async () => {
    const history: Message[] = [];
    const task = 'Trace src/a.ts, src/b.ts and src/c.ts; report the chain.';
    h.scripted.push(
      // Parent round 0: delegate.
      subagentResponse(task),
      // Subagent (subagentMaxTurns=3): read a.ts, read a.ts again, then the report round.
      readResponse('a.ts'),
      readResponse('a.ts', 'r2'),
      final('Chain: a.\nNot covered: b.ts, c.ts'),
      // Parent round 1: answer.
      final('done'),
    );
    await runTurn({
      userInput: 'trace a b c',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools: [readTool, subagentTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    // Subagent report round: no tools + directive, in the nested run (4th model call overall).
    expect(h.captured[3].tools).toEqual([]);
    expect(h.captured[3].system + (h.captured[3].trailingNote ?? '')).toContain(
      SUBAGENT_REPORT_DIRECTIVE,
    );
    const toolMsg = history.find(m => m.role === 'tool') as Message & { role: 'tool' };
    expect(toolMsg.summary).toContain('Subagent completed');
    expect(toolMsg.payload).toContain('Chain: a.');
    expect(toolMsg.payload).toContain('the task named 3 files');
    expect(toolMsg.payload).toContain('read src/a.ts and did not read src/b.ts, src/c.ts');
    expect(toolMsg.payload).toContain('hand them to subagent again');
  });

  it('refuses a spawn past the per-turn cap with a payload that says so', async () => {
    const history: Message[] = [];
    const calls = MAX_SUBAGENTS_PER_TURN + 1;
    for (let i = 0; i < calls; i++) {
      h.scripted.push(subagentResponse('look at a.ts', `s${i}`));
      // Each allowed subagent answers immediately (one round, no tools).
      if (i < MAX_SUBAGENTS_PER_TURN) h.scripted.push(final(`report ${i}`));
    }
    h.scripted.push(final('done'));
    await runTurn({
      userInput: 'go',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools: [readTool, subagentTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    const tools = history.filter(m => m.role === 'tool') as (Message & { role: 'tool' })[];
    expect(tools).toHaveLength(calls);
    expect(
      tools.slice(0, MAX_SUBAGENTS_PER_TURN).every(t => t.summary.includes('Subagent completed')),
    ).toBe(true);
    expect(tools[calls - 1].summary).toContain('budget for this turn exhausted');
    expect(tools[calls - 1].payload).toContain('Answer from their reports');
    // The refused spawn never reached the model.
    expect(vi.mocked(callModel).mock.calls.length).toBe(1 + MAX_SUBAGENTS_PER_TURN + calls);
  });
});
