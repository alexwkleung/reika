import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { latchesFor, resetEndpointLatches } from '../provider/latches.js';
import {
  COMPACTION_CALL_REFUSED,
  buildCompactionReportDirective,
  compactionNoteHeader,
  compactionNotePrefill,
} from './compactionreport.js';

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
    history: Message[];
    assistantPrefill?: string;
  }[],
  rejectPrefill: false,
  rejectAll: false,
  // Stream each reply's content in pieces this long; 0 sends it as one delta.
  chunk: 0,
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
      assistantPrefill?: string;
    }) => {
      if (h.rejectAll)
        throw new Error('chat/completions failed: 400 Bad Request — context too long');
      if (opts.assistantPrefill && h.rejectPrefill) {
        throw new Error('chat/completions failed: 400 Bad Request — final message must be user');
      }
      const next = h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
      const step = h.chunk || next.content?.length || 1;
      for (let at = 0; next.content && at < next.content.length; at += step) {
        opts.onContentDelta?.(next.content.slice(at, at + step));
      }
      h.captured.push({
        system: opts.system,
        tools: opts.tools.map(t => ({ name: t.name })),
        toolChoice: opts.toolChoice,
        trailingNote: opts.trailingNote,
        historyLen: opts.history.length,
        history: opts.history,
        assistantPrefill: opts.assistantPrefill,
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
  // The round's mechanics, on the unprefilled path; the prefill has its own block below.
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
    vi.mocked(callModel).mockClear();
    process.env.REIKA_NOTE_PREFILL = '0';
  });
  afterEach(() => {
    delete process.env.REIKA_COMPACTION_REPORT;
    delete process.env.REIKA_NOTE_PREFILL;
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
    // that a note is being asked for, then the note as a top-level (markdown-rendered) assistant
    // message carrying its reasoning as a trace and marked compactionNote, then the fold notice.
    // Not nested: an indent reads as a subagent, and nothing above it is one (#498).
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
    expect(shown.nested).toBeUndefined();
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
  // it has one; failing both, the longer reasoning is the fallback (#799).
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
    // #806: the retry answers the call in its own dialect, appended after the history it read.
    expect(h.captured[1].historyLen).toBe(h.captured[0].historyLen + 2);
    expect(h.captured[1].history.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning: 'let me search for that',
        toolCalls: [{ id: 'x', name: 'read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', callId: 'x', summary: COMPACTION_CALL_REFUSED },
    ]);
    // Request-only: neither the call nor its refusal reaches the model history.
    expect(history.some(m => m.role === 'tool' && m.summary === COMPACTION_CALL_REFUSED)).toBe(
      false,
    );
    const recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap.content).toContain('RETRY NOTE: established a');
    expect(recap.content).not.toContain('let me search');
    const last = history[history.length - 1] as Message & { role: 'assistant' };
    expect(last.content).toBe('final');
  });

  // #799: a text-format caller calls through `tool_choice: 'none'`, so content can be the call's
  // preamble rather than empty. That must trigger the retry, and when the retry does the same, the
  // longer reasoning — not the preamble — is the note.
  it('treats a tool-call preamble as no note, and falls back to the longer reasoning', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    const messages: Message[] = [];
    const findings = 'Change the failed branch in headless.ts to name the profile and base URL.';
    h.scripted.push(
      {
        content: 'Let me look at headless.ts:',
        reasoning: 'The context got folded.',
        toolCalls: [{ id: 'x', name: 'read', args: { path: 'src/headless.ts' } }],
      },
      {
        content: 'Let me examine `_net.ts` in detail:',
        reasoning: findings,
        toolCalls: [{ id: 'y', name: 'read', args: { path: 'src/tools/_net.ts' } }],
      },
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
      onMessage: m => messages.push(m),
    });
    expect(h.captured).toHaveLength(3);
    expect(directiveOf(h.captured[1])).toContain('your reply carried no note');
    const recap = history.find(m => m.role === 'compaction') as Message & { role: 'compaction' };
    expect(recap.content).toContain(compactionNoteHeader(1));
    expect(recap.content).toContain(findings);
    expect(recap.content).not.toContain('Let me examine');
    expect(recap.content).not.toContain('Let me look at headless.ts');
    const shown = messages.find(m => m.role === 'assistant' && m.compactionNote) as Message & {
      role: 'assistant';
    };
    expect(shown.content).toBe(findings);
  });

  it('falls back to the reasoning channel, and folds as before when the note is empty', async () => {
    process.env.REIKA_COMPACTION_REPORT = '1';
    h.scripted.push(
      { content: '', reasoning: 'reasoned note', toolCalls: undefined },
      // The retry comes back empty too: the longer reasoning (here the first) is the fallback.
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
    // A reply that made no call has nothing to refuse: the retry re-sends the same history.
    expect(h.captured[1].historyLen).toBe(h.captured[0].historyLen);

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

describe('the note round starts the reply on a local engine (#806)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
    h.rejectPrefill = false;
    h.rejectAll = false;
    h.chunk = 0;
    resetEndpointLatches();
  });
  afterEach(() => {
    delete process.env.REIKA_NOTE_PREFILL;
  });

  async function fold(config = makeConfig()): Promise<Message[]> {
    const history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config,
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });
    return history;
  }
  const recapOf = (history: Message[]): string =>
    (history.find(m => m.role === 'compaction') as Message & { role: 'compaction' }).content;
  const prefill = compactionNotePrefill(1);

  it('ends the note request in the prefill, and takes the echoed continuation as the note', async () => {
    h.scripted.push(
      { content: `${prefill}- the gate is bashTool.run (src/tools/bash.ts)\n\nOpen:\n- the UI` },
      { content: 'final', toolCalls: undefined },
    );
    const history = await fold();
    expect(h.captured[0].assistantPrefill).toBe(prefill);
    expect(h.captured[0].toolChoice).toBe('none');
    // The real request is an ordinary one: no prefill rides past the note round.
    expect(h.captured[1].assistantPrefill).toBeUndefined();
    expect(recapOf(history)).toContain('Established:\n- the gate is bashTool.run');
    expect(recapOf(history)).not.toContain('Compaction note 1');
  });

  it('accepts a reply that carries only the continuation', async () => {
    h.scripted.push({ content: '- the gate is bashTool.run' }, { content: 'final' });
    expect(recapOf(await fold())).toContain('Established:\n- the gate is bashTool.run');
  });

  // LFM2.5 at 16k: a written note, then a call, on both attempts, and the fold got no note.
  it('keeps a written note that ends in a call, and asks no retry', async () => {
    const body = `- the gate is bashTool.run (src/tools/bash.ts). ${'detail '.repeat(40)}`;
    h.scripted.push(
      {
        content: `${prefill}${body}`,
        toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
      },
      { content: 'final', toolCalls: undefined },
    );
    const history = await fold();
    expect(h.captured.filter(c => c.toolChoice === 'none')).toHaveLength(1);
    expect(recapOf(history)).toContain('Established:\n- the gate is bashTool.run');
  });

  // #819: streamed raw, the thinking, the tag and the call drew and then vanished on commit.
  it('streams only the note a prefilled reply commits', async () => {
    const body = `- the gate is bashTool.run (src/tools/bash.ts). ${'detail '.repeat(40)}`;
    h.chunk = 3;
    h.scripted.push(
      {
        content: `${prefill}${body}\n\nNow let me read b.ts.\n</think>\n\n<tool_call>{"name":"noop"}</tool_call>`,
        toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
      },
      { content: 'final', toolCalls: undefined },
    );
    let streamed = '';
    const history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
      onContentDelta: d => (streamed += d),
    });
    const note = `Established:\n${body}\n\nNow let me read b.ts.`;
    expect(recapOf(history)).toContain(note);
    expect(streamed).toBe(`${note}final`);
  });

  it('is off for a hosted API and under REIKA_NOTE_PREFILL=0', async () => {
    h.scripted.push({ content: 'Established: a' }, { content: 'final' });
    await fold({ ...makeConfig(), baseURL: 'https://api.example.com/v1' });
    expect(h.captured[0].assistantPrefill).toBeUndefined();
    h.captured.length = 0;
    process.env.REIKA_NOTE_PREFILL = '0';
    h.scripted.push({ content: 'Established: a' }, { content: 'final' });
    await fold();
    expect(h.captured[0].assistantPrefill).toBeUndefined();
  });

  it('latches the prefill off for an engine that rejects it, and asks the plain way', async () => {
    h.rejectPrefill = true;
    h.scripted.push({ content: 'Established: plain note' }, { content: 'final' });
    const history = await fold();
    // The rejected request never reached the mock's log; the plain one did, and wrote the note.
    expect(h.captured[0].assistantPrefill).toBeUndefined();
    expect(recapOf(history)).toContain('Established: plain note');
    // Latched: the next fold on the same endpoint does not try it again.
    h.captured.length = 0;
    h.scripted.push({ content: 'Established: second' }, { content: 'final' });
    await fold();
    expect(h.captured[0].assistantPrefill).toBeUndefined();
    expect(latchesFor(makeConfig()).assistantPrefill).toBe(true);
  });

  it('does not latch on a failure the plain request shares', async () => {
    h.rejectAll = true;
    const history = bigHistory();
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    }).catch(() => {});
    expect(latchesFor(makeConfig()).assistantPrefill).toBe(false);
  });
});
