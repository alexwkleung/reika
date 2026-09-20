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
import { grepTool } from '../tools/grep.js';
import { writeTool } from '../tools/write.js';
import {
  MAX_SUBAGENTS_PER_ROUND,
  MAX_SUBAGENTS_PER_TURN,
  SUBAGENT_HOLD_NOTE,
  SUBAGENT_REPORT_DIRECTIVE,
} from './subagentreport.js';

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
  callModel: vi.fn(
    async (
      opts: Captured & {
        onReasoningDelta?: (t: string) => void;
        onContentDelta?: (t: string) => void;
      },
    ) => {
      // Streaming: the model "types" a reasoning and content delta before answering, so a test can
      // see whether they reached the caller's callbacks.
      opts.onReasoningDelta?.('thinking…');
      opts.onContentDelta?.('typing…');
      h.captured.push({
        system: opts.system,
        tools: opts.tools.map(t => ({ name: t.name })),
        trailingNote: opts.trailingNote,
        historyLen: opts.history.length,
      });
      return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
    },
  ),
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
    bashIdleMs: 5000,
    pasteFetch: false,
    skillAuto: 'off',
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

  // #342: the subagent streams into the parent's live region. The parent is blocked inside the
  // tool call with its own assistant message committed, so the region is idle for the duration.
  it('forwards streaming/phase callbacks and brackets the run with onSubagent', async () => {
    const history: Message[] = [];
    const events: string[] = [];
    h.scripted.push(
      subagentResponse('look at src/a.ts'),
      readResponse('a.ts'),
      final('sub report'),
      final('done'),
    );
    await runTurn({
      userInput: 'go',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig({ subagentMaxTurns: 2 }),
      tools: [readTool, subagentTool],
      payloads: new PayloadStore(),
      onMessage: m => events.push(`msg:${m.role}${'nested' in m && m.nested ? ':nested' : ''}`),
      onReasoningDelta: t => events.push(`reasoning:${t}`),
      onContentDelta: t => events.push(`content:${t}`),
      onPhase: p => events.push(`phase:${p}`),
      onSubagent: a => events.push(`subagent:${a}`),
    });
    const start = events.indexOf('subagent:true');
    const end = events.indexOf('subagent:false');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const inside = events.slice(start + 1, end);
    // The subagent's two rounds streamed reasoning + content into the parent's callbacks, and
    // committed nested messages between them.
    expect(inside.filter(e => e === 'reasoning:thinking…')).toHaveLength(2);
    expect(inside.filter(e => e === 'content:typing…')).toHaveLength(2);
    expect(inside).toContain('phase:thinking');
    expect(inside).toContain('msg:assistant:nested');
    expect(inside).toContain('msg:tool:nested');
    // On return the phase is restored to the parent's dispatch phase.
    expect(events[end + 1]).toBe('phase:tool');
  });

  // #346: a subagent call is exclusive in its round. The observed hedge — "call subagent
  // (mandatory first call) and read a few core files in parallel" — truncated the report itself on
  // the next round's cap. Sibling inspection calls are held; the report is the round's only payload.
  describe('exclusive round (#346)', () => {
    const toolMsgs = (history: Message[]) =>
      history.filter(m => m.role === 'tool') as (Message & { role: 'tool' })[];

    it('holds sibling read/grep calls in the round a subagent is dispatched, whichever side they sit', async () => {
      const history: Message[] = [];
      h.scripted.push(
        {
          content: '',
          toolCalls: [
            { id: 'r1', name: 'read', args: { path: 'a.ts' } },
            { id: 's1', name: 'subagent', args: { task: 'look at src/a.ts' } },
            { id: 'g1', name: 'grep', args: { pattern: 'const', path: '.' } },
          ],
        },
        final('sub report'),
        final('done'),
      );
      await runTurn({
        userInput: 'go',
        history,
        bundle: makeBundle(cwd),
        config: makeConfig({ subagentMaxTurns: 2 }),
        tools: [readTool, grepTool, subagentTool],
        payloads: new PayloadStore(),
        onMessage: () => {},
      });
      // Top-level tool messages only (the nested subagent turn has none here — it answered at once).
      const tools = toolMsgs(history);
      expect(tools.map(t => t.callId)).toEqual(['r1', 's1', 'g1']);
      expect(tools[0].summary).toBe('read held — the subagent dispatched this round covers it');
      expect(tools[0].payload).toBe(SUBAGENT_HOLD_NOTE);
      expect(tools[0].payload).not.toContain('export const a');
      expect(tools[1].summary).toContain('Subagent completed');
      expect(tools[2].summary).toBe('grep held — the subagent dispatched this round covers it');
      expect(tools[2].payload).toBe(SUBAGENT_HOLD_NOTE);
    });

    it('does not hold when the spawn itself would be refused by the per-turn cap', async () => {
      const history: Message[] = [];
      for (let i = 0; i < MAX_SUBAGENTS_PER_TURN; i++) {
        h.scripted.push(subagentResponse('look at src/a.ts', `s${i}`), final(`report ${i}`));
      }
      // One past the cap, with a read alongside: the spawn is refused, the read must run.
      h.scripted.push(
        {
          content: '',
          toolCalls: [
            { id: 'sX', name: 'subagent', args: { task: 'again' } },
            { id: 'rX', name: 'read', args: { path: 'a.ts' } },
          ],
        },
        final('done'),
      );
      await runTurn({
        userInput: 'go',
        history,
        bundle: makeBundle(cwd),
        config: makeConfig(),
        tools: [readTool, subagentTool],
        payloads: new PayloadStore(),
        onMessage: () => {},
      });
      const tools = toolMsgs(history);
      const last = tools[tools.length - 1];
      expect(last.callId).toBe('rX');
      expect(last.summary).toContain('Read a.ts');
      expect(last.payload).toContain('export const a');
    });

    it('leaves a mutating sibling alone — a write beside a subagent still runs', async () => {
      const history: Message[] = [];
      h.scripted.push(
        {
          content: '',
          toolCalls: [
            { id: 's1', name: 'subagent', args: { task: 'look at src/a.ts' } },
            { id: 'w1', name: 'write', args: { path: 'c.ts', content: 'export const c = 3;\n' } },
          ],
        },
        final('sub report'),
        final('done'),
      );
      await runTurn({
        userInput: 'go',
        history,
        bundle: makeBundle(cwd),
        config: makeConfig({ subagentMaxTurns: 2 }),
        tools: [readTool, writeTool, subagentTool],
        payloads: new PayloadStore(),
        onMessage: () => {},
      });
      const tools = toolMsgs(history);
      expect(tools.find(t => t.callId === 'w1')?.summary).toContain('Wrote');
    });

    it('does not seed the repeat detector: a real read of a held path afterwards is not a repeat', async () => {
      const history: Message[] = [];
      h.scripted.push(
        {
          content: '',
          toolCalls: [
            { id: 's1', name: 'subagent', args: { task: 'look at src/a.ts' } },
            { id: 'r1', name: 'read', args: { path: 'a.ts' } },
          ],
        },
        final('sub report'),
        readResponse('a.ts', 'r2'),
        final('done'),
      );
      await runTurn({
        userInput: 'go',
        history,
        bundle: makeBundle(cwd),
        config: makeConfig({ subagentMaxTurns: 2 }),
        tools: [readTool, subagentTool],
        payloads: new PayloadStore(),
        onMessage: () => {},
      });
      const r2 = toolMsgs(history).find(t => t.callId === 'r2');
      expect(r2?.payload).toContain('export const a');
      expect(r2?.payload).not.toContain('re-read this same range');
    });
  });

  // #354: the cap counts decisions (rounds), not calls. A four-stage parallel decomposition in one
  // round is one decision; width within a round is bounded separately.
  describe('parallel spawns (#354)', () => {
    const parallel = (n: number, id: string): ModelResponse => ({
      content: '',
      toolCalls: Array.from({ length: n }, (_, i) => ({
        id: `${id}${i}`,
        name: 'subagent',
        args: { task: `stage ${i}` },
      })),
    });
    const toolMsgs = (history: Message[]) =>
      history.filter(m => m.role === 'tool') as (Message & { role: 'tool' })[];

    it('honours a full-width parallel round as one decision', async () => {
      const history: Message[] = [];
      h.scripted.push(parallel(MAX_SUBAGENTS_PER_ROUND, 'p'));
      for (let i = 0; i < MAX_SUBAGENTS_PER_ROUND; i++) h.scripted.push(final(`report ${i}`));
      // Two more serial decisions are still allowed after it.
      h.scripted.push(subagentResponse('remainder', 'q'), final('report q'));
      h.scripted.push(subagentResponse('retry', 'r'), final('report r'));
      h.scripted.push(subagentResponse('one too many', 'x'), final('done'));
      await runTurn({
        userInput: 'go',
        history,
        bundle: makeBundle(cwd),
        config: makeConfig(),
        tools: [readTool, subagentTool],
        payloads: new PayloadStore(),
        onMessage: () => {},
      });
      const tools = toolMsgs(history);
      const honoured = tools.filter(t => t.summary.includes('Subagent completed'));
      expect(honoured).toHaveLength(MAX_SUBAGENTS_PER_ROUND + 2);
      expect(tools[tools.length - 1].summary).toContain('budget for this turn exhausted');
    });

    it('refuses the call past the width bound within one round, and says so', async () => {
      const history: Message[] = [];
      h.scripted.push(parallel(MAX_SUBAGENTS_PER_ROUND + 1, 'w'));
      for (let i = 0; i < MAX_SUBAGENTS_PER_ROUND; i++) h.scripted.push(final(`report ${i}`));
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
      const tools = toolMsgs(history);
      expect(tools).toHaveLength(MAX_SUBAGENTS_PER_ROUND + 1);
      expect(tools[MAX_SUBAGENTS_PER_ROUND].summary).toContain('width for this round exhausted');
      expect(tools[MAX_SUBAGENTS_PER_ROUND].payload).toContain('Fold this task into a later round');
    });
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
