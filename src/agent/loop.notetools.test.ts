import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Message, Tool } from '../types.js';

// #816: inspection withdrawal starting on the round a fold is due changed the note request's tool
// list, and a template renders that list into the system turn, so the note round re-prefilled the
// whole prompt (~27k tokens on a 32k run) for tools it could not call. Driven through runTurn: a
// read loop withdraws on the same round a seeded history folds.
// Pinned to REIKA_WITHDRAW_KEEP_TOOLS=0: since #867 the default keeps the list, so only the baseline
// arm changes it.

const h = vi.hoisted(() => {
  process.env.REIKA_WITHDRAW_KEEP_TOOLS = '0';
  return {
    scripted: [] as ModelResponse[],
    calls: [] as { tools: string[]; toolChoice?: 'none' }[],
  };
});
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { tools: { name: string }[]; toolChoice?: 'none' }) => {
    h.calls.push({ tools: opts.tools.map(t => t.name), toolChoice: opts.toolChoice });
    // The note round gets a note; every other request takes the next scripted reply.
    if (opts.toolChoice === 'none') return { content: 'Established: a. Open: b.' };
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

const readTool: Tool = {
  name: 'read',
  description: 'reads',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async () => ({
    summary: 'Read app.ts lines 1-40 of 40',
    payload: 'x'.repeat(400),
    contentHash: 'h',
  }),
};
const bashTool: Tool = {
  name: 'bash',
  description: 'runs',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  run: async () => ({ summary: 'Ran: true', exitCode: 0 }),
};

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 12,
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

// Earlier turns as assistant prose, which no shed can collapse, so the fold has to run. Sized to
// stay under the threshold until the read loop's rounds push it over.
function seededHistory(turns: number, pad = 0): Message[] {
  const out: Message[] = [];
  if (pad) out.push({ role: 'user', content: 'z'.repeat(pad) });
  for (let t = 0; t < turns; t++) {
    out.push({ role: 'user', content: `task ${t}` });
    out.push({ role: 'assistant', content: `finished ${t}. ${'y'.repeat(2400)}` });
  }
  return out;
}

const readRound = (n: number): ModelResponse => ({
  content: '',
  toolCalls: [{ id: `r${n}`, name: 'read', args: { path: 'app.ts' } }],
});

// R = a request offering `read`, . = one without it (withdrawn), N = the note request.
const shape = (calls: typeof h.calls): string =>
  calls.map(c => (c.toolChoice ? 'N' : c.tools.includes('read') ? 'R' : '.')).join('');

describe('the compaction note round sends the previous request’s tool list (#816)', () => {
  it('keeps the note request on the last sent list when withdrawal starts on the fold round', async () => {
    h.calls.length = 0;
    h.scripted.length = 0;
    for (let n = 0; n < 6; n++) h.scripted.push(readRound(n));
    await runTurn({
      userInput: 'fix the bug',
      // Sized so the seed crosses the fold threshold on round 3, the round the read loop withdraws.
      history: seededHistory(8, 600),
      bundle: {
        projectSummary: '',
        repoMap: '',
        instructions: '',
        cwd: process.cwd(),
        hash: 'test',
        fileIndex: [],
        ignore: ignore(),
        skills: [],
      },
      config,
      tools: [readTool, bashTool],
      payloads: new PayloadStore(),
      promptMode: 'agent',
      onMessage: () => {},
    });
    // If the thresholds move, re-size the seed until the fold and the withdrawal share a round.
    expect(shape(h.calls)).toMatch(/^RRRN\./);
    expect(h.calls[3].tools).toEqual(h.calls[2].tools);
    expect(h.calls[4].tools).toEqual(['bash']);
  });

  // A subagent's last budgeted round forbids calls the same way (#340), so it is the same request.
  it('keeps a subagent report round on the last sent list when withdrawal starts on it', async () => {
    h.calls.length = 0;
    h.scripted.length = 0;
    for (let n = 0; n < 3; n++) h.scripted.push(readRound(n));
    await runTurn({
      userInput: 'trace the flow',
      history: [],
      bundle: {
        projectSummary: '',
        repoMap: '',
        instructions: '',
        cwd: process.cwd(),
        hash: 'test',
        fileIndex: [],
        ignore: ignore(),
        skills: [],
      },
      config: { ...config, contextWindow: undefined, maxTurns: 4 },
      tools: [readTool, bashTool],
      payloads: new PayloadStore(),
      promptMode: 'agent',
      reportAtCap: true,
      onMessage: () => {},
    });
    expect(shape(h.calls)).toBe('RRRN');
    expect(h.calls[3].tools).toEqual(h.calls[2].tools);
  });
});
