import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { PrefixTrace } from './prefixtrace.js';

// #426: two prefix-cache costs the trace could not see. (1) The compaction-note round sent no
// tools, and a template renders the tool list into the system turn, so that request re-prefilled
// the whole prompt right before the fold re-prefilled it again — and since the messages were
// byte-identical the log never said so. It now keeps the tools with calls forbidden, gets its own
// `phase=report` line, and the trace compares tool lists. (2) The trace was turn-scoped, so a new
// turn's round 0 always read `first-request` and the boundary went unmeasured. Both are driven
// through runTurn with the REAL serializer, the way loop.prefixnote.test.ts does.
const PRIOR: Record<string, string | undefined> = {};
for (const k of [
  'REIKA_PREFIX_STABLE',
  'REIKA_COMPACTION_REPORT',
  'REIKA_DEBUG',
  'REIKA_DEBUG_FILE',
]) {
  PRIOR[k] = process.env[k];
}
process.env.REIKA_PREFIX_STABLE = '1';
process.env.REIKA_COMPACTION_REPORT = '1';
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  for (const [k, v] of Object.entries(PRIOR)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as {
    tools: string[];
    toolChoice?: 'none';
    stampRenders?: boolean;
    // How many tool payloads were already aged when this request was built.
    agedAtCall: number;
  }[],
}));
vi.mock('../provider/client.js', async () => {
  const { messagesToChatParams: toChatParams } = await import('../provider/toolcall.js');
  return {
    // Mirrors client.ts's own composition so onRequest sees the bytes a real call would send.
    callModel: vi.fn(
      async (opts: {
        system: string;
        history: Message[];
        tools: Tool[];
        toolChoice?: 'none';
        config: Config;
        prefixStable?: boolean;
        stampRenders?: boolean;
        trailingNote?: string;
        onRequest?: (m: unknown[]) => void;
      }) => {
        h.captured.push({
          tools: opts.tools.map(t => t.name),
          toolChoice: opts.toolChoice,
          stampRenders: opts.stampRenders,
          agedAtCall: opts.history.filter(m => m.role === 'tool' && m.aged).length,
        });
        opts.onRequest?.(
          toChatParams(opts.system, opts.history, {
            contextWindow: opts.config.contextWindow,
            reasoningRounds: opts.config.reasoningRounds,
            minGenTokens: opts.config.minGenTokens,
            prefixStable: opts.prefixStable,
            stampRenders: opts.stampRenders ?? opts.prefixStable,
            trailingNote: opts.trailingNote,
          }),
        );
        return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
      },
    ),
  };
});

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

const readTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Heavy enough that round 0 of a new turn crosses the threshold (loop.compactionreport.test shape),
// but with the weight in assistant content and the payloads already aged: batch aging then has
// nothing left to shed, so the fold fires on its own and the note round's request is exactly the
// previous request plus its note — the clean case, with no shrink event mixed into the line.
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
      payload: 'x'.repeat(200),
      aged: true,
    });
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(5000)}` });
  }
  return out;
}

// The same shape with the payloads LIVE, so the event has a real shed in it. This is the case the
// first live fold after #428 showed: the note request paid the shed's rewrite, the real request
// paid the fold's. Byte-frozen renders as the previous round would have left them.
function liveHistory(): Message[] {
  return bigHistory().map(m =>
    m.role === 'tool'
      ? { ...m, aged: undefined, payload: 'x'.repeat(3000), rendered: `${m.summary}\n\nlive` }
      : m,
  );
}

const run = (history: Message[], userInput: string, prefixTrace?: PrefixTrace) =>
  runTurn({
    userInput,
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [readTool],
    payloads: new PayloadStore(),
    onMessage: () => {},
    prefixTrace,
  });

describe('prefix-cache visibility of the report round and the turn boundary (#426)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-prefixtools-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
    h.captured.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the tool list on the note round so it is not a tools-changed re-prefill', async () => {
    const trace = new PrefixTrace();
    // Turn 1 is quiet: one round, establishes the baseline the note round is compared against.
    h.scripted.push({ content: 'ok', toolCalls: undefined });
    const history = bigHistory().slice(0, 8);
    await run(history, 'warm up', trace);
    // Turn 2 opens over the threshold: the note round, then the fold, then the real round 0.
    history.push(...bigHistory().slice(8));
    h.scripted.push({ content: 'the note', toolCalls: undefined });
    h.scripted.push({ content: 'final', toolCalls: undefined });
    await run(history, 'keep going', trace);

    const log = await readFile(logPath, 'utf8');
    const lines = log.split('\n').filter(l => l.includes('] prefix-cache round='));
    const report = lines.find(l => l.includes('phase=report'));
    expect(report).toBeDefined();
    // Same tools as the round before, calls forbidden by the field instead of by absence.
    const reportCall = h.captured[1];
    expect(reportCall.tools).toEqual(['read']);
    expect(reportCall.toolChoice).toBe('none');
    // The note round is an append on the previous request (its note is the only moved slot),
    // and the fold that follows is what changes the system — not the note round.
    expect(report).toContain('cause=trailing-note');
    expect(report).not.toContain('tools-changed');
    const afterFold = lines[lines.indexOf(report!) + 1];
    expect(afterFold).toContain('cause=system-changed');
    expect(afterFold).not.toContain('phase=report');
  });

  it('writes the note before the shed, so the shed and the fold land on one request', async () => {
    const trace = new PrefixTrace();
    h.scripted.push({ content: 'ok', toolCalls: undefined });
    const history = liveHistory().slice(0, 8);
    await run(history, 'warm up', trace);
    history.push(...liveHistory().slice(8));
    h.scripted.push({ content: 'the note', toolCalls: undefined });
    h.scripted.push({ content: 'final', toolCalls: undefined });
    await run(history, 'keep going', trace);

    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('batch-age marked=');
    const lines = log.split('\n').filter(l => l.includes('] prefix-cache round='));
    const report = lines.find(l => l.includes('phase=report'))!;
    // Nothing aged yet when the note was asked for: the request is the previous round plus its
    // note, and the model writes from the live bytes about to be collapsed.
    expect(h.captured[1].agedAtCall).toBe(0);
    // append-only here (the quiet first turn carried no note to displace); trailing-note once one
    // rides — either is the append, and neither names a rewritten role.
    expect(report).toMatch(/cause=(append-only|trailing-note) /);
    expect(report).not.toContain('firstChanged=');
    // The shed then lands together with the fold on the real request, which was going to diverge
    // from the top anyway.
    const real = lines[lines.indexOf(report) + 1];
    expect(real).toContain('cause=system-changed');
    // Order in the log: note request, THEN the shed, then the fold (the fold then removes the
    // aged messages, so the real request's history has none left to count).
    expect(log.indexOf('batch-age marked=')).toBeGreaterThan(log.indexOf('phase=report'));
    expect(log.indexOf('compaction removed=')).toBeGreaterThan(log.indexOf('batch-age marked='));
    // The note request must not freeze this round's fresh payloads at the tightest cap of the
    // event; the real request renders and stamps them with the post-fold room.
    expect(h.captured[1].stampRenders).toBe(false);
    expect(h.captured[2].stampRenders).toBeUndefined();
  });

  it('reports a tool-list change ahead of every message-level cause', async () => {
    const trace = new PrefixTrace();
    h.scripted.push({ content: 'ok', toolCalls: undefined });
    const history: Message[] = [];
    await run(history, 'first', trace);
    h.scripted.push({ content: 'ok again', toolCalls: undefined });
    await runTurn({
      userInput: 'second',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [readTool, { ...readTool, name: 'grep' }],
      payloads: new PayloadStore(),
      onMessage: () => {},
      prefixTrace: trace,
    });
    const lines = (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(l => l.includes('] prefix-cache round='));
    expect(lines[1]).toContain('cause=tools-changed');
    expect(lines[1]).toContain('stable=0/');
  });

  it('measures the turn boundary when the caller keeps one trace across turns', async () => {
    const trace = new PrefixTrace();
    h.scripted.push({ content: 'ok', toolCalls: undefined });
    const history: Message[] = [];
    await run(history, 'first', trace);
    h.scripted.push({ content: 'ok again', toolCalls: undefined });
    await run(history, 'second', trace);

    const lines = (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(l => l.includes('] prefix-cache round='));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cause=first-request');
    // The next turn's round 0 is the previous turn's last request plus the reply and the new user
    // message — an append, priced as one instead of as an unmeasured ceiling.
    expect(lines[1]).toContain('round=0 cause=append-only');
    expect(lines[1]).not.toContain('reprocess≤');
  });

  it('starts fresh without a shared trace, as a subagent turn does', async () => {
    h.scripted.push({ content: 'ok', toolCalls: undefined });
    const history: Message[] = [];
    await run(history, 'first');
    h.scripted.push({ content: 'ok again', toolCalls: undefined });
    await run(history, 'second');
    const lines = (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(l => l.includes('] prefix-cache round='));
    expect(lines.map(l => /cause=(\S+)/.exec(l)?.[1])).toEqual(['first-request', 'first-request']);
  });
});
