import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { buildCompactionReportDirective, compactionNoteHeader } from './compactionreport.js';

// #280: the report round before a fold, driven through the real runTurn with a scripted model and
// a window small enough that a seeded history folds on round 0.

type Captured = {
  system: string;
  tools: { name: string }[];
  trailingNote?: string;
  historyLen: number;
};
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as {
    system: string;
    tools: { name: string }[];
    toolChoice?: 'none';
    trailingNote?: string;
    historyLen: number;
  }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(
    async (opts: {
      system: string;
      tools: Tool[];
      toolChoice?: 'none';
      trailingNote?: string;
      history: Message[];
      onContentDelta?: (t: string) => void;
    }) => {
      const next = h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
      if (next.content) opts.onContentDelta?.(next.content);
      h.captured.push({
        system: opts.system,
        tools: opts.tools.map(t => ({ name: t.name })),
        toolChoice: opts.toolChoice,
        trailingNote: opts.trailingNote,
        historyLen: opts.history.length,
      });
      return next;
    },
  ),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd: process.cwd(),
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
    contextWindow: 8192,
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

const noopTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Heavy enough that round 0 of a new turn crosses the threshold (same shape as loop.recaplog.test).
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
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(3000)}` });
  }
  return out;
}

const directiveOf = (c: Captured): string => c.system + (c.trailingNote ?? '');
const NOTE = 'Established: the gate is bashTool.run (src/tools/bash.ts). Open: the UI handler.';

describe('compaction report round (#280)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(() => {
    delete process.env.REIKA_COMPACTION_REPORT;
  });

  it('is a strict no-op with the flag off: one call, no directive, ledger recap', async () => {
    process.env.REIKA_COMPACTION_REPORT = '0';
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
    expect(h.captured).toHaveLength(1);
    expect(directiveOf(h.captured[0])).not.toContain('compaction note');
    const recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap).toBeDefined();
    expect(recap.content).not.toContain(compactionNoteHeader(1));
  });

  it('spends one call-forbidden round on the note before the fold, and the recap carries it', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    const messages: Message[] = [];
    h.scripted.push(
      { content: NOTE, reasoning: 'how I got here', toolCalls: undefined },
      { content: 'final', toolCalls: undefined },
    );
    const history = bigHistory();
    const before = history.length;
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: m => messages.push(m),
    });
    expect(h.captured).toHaveLength(2);
    // Report call: the round's tools kept with calls forbidden (#426 — withholding them re-rendered
    // the system turn and re-prefilled the whole request), numbered directive, the UNFOLDED history
    // (the note is written from the material that is about to be dropped).
    const rep = h.captured[0];
    expect(rep.tools.map(t => t.name)).toEqual(['read']);
    expect(rep.toolChoice).toBe('none');
    expect(directiveOf(rep)).toContain(buildCompactionReportDirective(1));
    expect(rep.historyLen).toBe(before + 1);
    // Real call: tools back, no directive, folded history with the note leading the recap.
    const real = h.captured[1];
    expect(real.tools.map(t => t.name)).toEqual(['read']);
    expect(real.toolChoice).toBeUndefined();
    expect(directiveOf(real)).not.toContain('compaction note');
    expect(real.historyLen).toBeLessThan(rep.historyLen);
    const recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap.content).toContain(compactionNoteHeader(1));
    expect(recap.content).toContain(NOTE);
    // The note never enters history as an assistant message. The user sees: a top-level notice
    // that a note is being asked for, then the note as a nested (markdown-rendered) assistant
    // message carrying its reasoning as a trace and marked compactionNote, then the fold notice.
    expect(history.some(m => m.role === 'assistant' && m.content === NOTE)).toBe(false);
    const startAt = messages.findIndex(
      m => m.role === 'system' && m.content.includes('compaction note before fold 1'),
    );
    expect(startAt).toBeGreaterThan(-1);
    expect((messages[startAt] as { nested?: boolean }).nested).toBeUndefined();
    const shown = messages[startAt + 1] as Message & { role: 'assistant' };
    expect(shown.role).toBe('assistant');
    expect(shown.content).toBe(NOTE);
    expect(shown.reasoning).toBe('how I got here');
    expect(shown.nested).toBe(true);
    expect(shown.compactionNote).toBe(true);
    const foldAt = messages.findIndex(
      m => m.role === 'system' && m.content.includes('Context compacted (fold 1)'),
    );
    expect(foldAt).toBe(startAt + 2);
    // The turn still ends on the real reply.
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.content).toBe('final');
  });

  // An empty content channel gets ONE retry with the sharper directive (observed: the model
  // emitted an in-band tool call instead of the note at 91% context). The retry's note wins when
  // it has one; failing both, the first reply's reasoning is the fallback.
  it('retries once on an empty note and takes the retry when it carries one', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    h.scripted.push(
      {
        content: '',
        reasoning: 'let me search for that',
        toolCalls: [{ id: 'x', name: 'read', args: { path: 'a.ts' } }],
      },
      { content: 'RETRY NOTE: established a; open b', toolCalls: undefined },
      { content: 'final', toolCalls: undefined },
    );
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
    expect(h.captured).toHaveLength(3);
    expect(directiveOf(h.captured[0])).toContain(buildCompactionReportDirective(1));
    expect(directiveOf(h.captured[0])).not.toContain('your reply carried no note');
    expect(h.captured[1].toolChoice).toBe('none');
    expect(directiveOf(h.captured[1])).toContain('your reply carried no note');
    const recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap.content).toContain('RETRY NOTE: established a');
    expect(recap.content).not.toContain('let me search');
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.content).toBe('final');
  });

  it('falls back to the reasoning channel, and folds as before when the note is empty', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    h.scripted.push(
      { content: '', reasoning: 'reasoned note', toolCalls: undefined },
      // The retry comes back empty too: the FIRST reasoning is the fallback.
      { content: '', reasoning: 'second try', toolCalls: undefined },
      { content: 'final', toolCalls: undefined },
    );
    let history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    let recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap.content).toContain('reasoned note');

    h.scripted.length = 0;
    h.captured.length = 0;
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: '', toolCalls: undefined },
      { content: 'final', toolCalls: undefined },
    );
    history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap).toBeDefined();
    expect(recap.content).not.toContain(compactionNoteHeader(1));
    expect(recap.content).toContain('Files touched');
  });

  // Under PREFIX_STABLE the shed often gets the request under the threshold and the fold then keeps
  // everything; a note written there has no recap to live in. Here: one huge pinned user message —
  // the estimate is over the threshold, but the fold cannot remove the pinned message, so nothing
  // would fold and no report round must be spent.
  it('does not spend a report round when the fold would remove nothing', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    h.scripted.push({ content: 'final', toolCalls: undefined });
    const history: Message[] = [{ role: 'user', content: 'x'.repeat(60000) }];
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    expect(h.captured).toHaveLength(1);
    expect(directiveOf(h.captured[0])).not.toContain('compaction note');
    expect(history.some(m => m.role === 'compaction')).toBe(false);
  });

  it('never runs in plan mode', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    h.scripted.push({ content: '1. plan step', toolCalls: undefined });
    const history = bigHistory();
    await runTurn({
      userInput: 'plan it',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      promptMode: 'plan',
    });
    expect(h.captured).toHaveLength(1);
    expect(directiveOf(h.captured[0])).not.toContain('compaction note');
  });
});
