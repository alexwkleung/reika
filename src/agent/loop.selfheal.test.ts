import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The gate consts are read at loop.js import time, so the flags must be set before the import.
// Drives a real runTurn into the reasoning-loop terminal and asserts the restart actually replaces
// the conversation rather than ending the turn (#137).
const PRIOR = {
  heal: process.env.REIKA_SELF_HEAL,
  rloop: process.env.REIKA_REASONING_LOOP,
  converge: process.env.REIKA_CONVERGE_RETRY,
  logit: process.env.REIKA_LOGIT_RECOVERY,
};
process.env.REIKA_SELF_HEAL = '1';
process.env.REIKA_REASONING_LOOP = '1';
// Off so the restart is the FIRST rung reached after the ledger/withdrawal — otherwise the cheaper
// tiers absorb the terminal and the restart never fires within the scripted rounds.
delete process.env.REIKA_CONVERGE_RETRY;
delete process.env.REIKA_LOGIT_RECOVERY;
afterAll(() => {
  for (const [k, v] of [
    ['REIKA_SELF_HEAL', PRIOR.heal],
    ['REIKA_REASONING_LOOP', PRIOR.rloop],
    ['REIKA_CONVERGE_RETRY', PRIOR.converge],
    ['REIKA_LOGIT_RECOVERY', PRIOR.logit],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// runTurn keeps mutating the shared history array after each call, so snapshot it at call time.
const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[], sent: [] as unknown[][] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { history: unknown[] }) => {
    h.sent.push(JSON.parse(JSON.stringify(opts.history)));
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

const makeBundle = (): ContextBundle => ({
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
  hash: 'test',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
});

const makeConfig = (): Config => ({
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 40,
  repoMapBudget: 1000,
  autoApprove: 'bypass',
  subagentMaxTurns: 5,
  profiles: {},
  contextWindow: 16384,
  minGenTokens: 1024,
  reasoningRounds: 1,
  maxSearchesPerTurn: 0,
  maxFetchesPerTurn: 0,
  bashTimeoutMs: 5000,
  pasteFetch: false,
  skillAuto: false,
  anon: false,
});

const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

const RUMINATION =
  'I need to check whether the helper is exported before I can change the call site, and to do ' +
  'that I should verify the module boundary once more before committing to any concrete edit at all.';

const spiralRound = (): ModelResponse => ({
  content: '',
  reasoning: RUMINATION,
  toolCalls: [{ id: `c${h.scripted.length}`, name: 'noop', args: {} }],
});

async function drive(spiralRounds: number, then: ModelResponse) {
  h.scripted.length = 0;
  h.sent.length = 0;
  for (let n = 0; n < spiralRounds; n++) h.scripted.push(spiralRound());
  h.scripted.push(then);
  const history: Message[] = [];
  const receipts: string[] = [];
  await runTurn({
    userInput: 'add retry with backoff to the fetch helper',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [noop],
    payloads: new PayloadStore(),
    onMessage: m => {
      if (m.role === 'system') receipts.push(m.content);
    },
    promptMode: 'agent',
  });
  return { history, receipts };
}

describe('self-healing restart (#137)', () => {
  it('restarts instead of stopping, and says so in a persistent notice', async () => {
    const { receipts } = await drive(6, {
      content: 'converged: added backoff',
      toolCalls: undefined,
    });
    const notice = receipts.find(r => r.includes('restarting'));
    expect(notice).toBeDefined();
    // Bounded, and it says so — the user must be able to see it will not churn.
    expect(notice).toContain('1 of 2');
  });

  it('rebuilds the conversation around the request, verbatim', async () => {
    await drive(6, { content: 'converged', toolCalls: undefined });
    // The request sent to the model after the restart, byte-for-byte.
    const last = h.sent[h.sent.length - 1] as { role: string; content?: string }[];
    const users = last.filter(m => m.role === 'user').map(m => m.content);
    expect(users).toContain('add retry with backoff to the fetch helper');
  });

  // Not a size assertion: the digest carries a fixed banner and instruction block, so on a short
  // spiral the rebuild can be LARGER than what it replaced (it only shrinks once the spiral is long
  // — restart.test.ts covers that bound). What must hold at any length is that the ruminated text
  // itself is gone.
  it('leaves the ruminated text behind — the spiral does not survive the restart', async () => {
    await drive(6, { content: 'converged', toolCalls: undefined });
    // Compare across the restart BOUNDARY, not at the end of the turn: the scripted model keeps
    // spiraling after the restart, so the final call legitimately contains ruminated text again.
    const restartAt = h.sent.findIndex(ms => (ms as { role: string }[])[0]?.role === 'compaction');
    expect(restartAt).toBeGreaterThan(0);
    const before = JSON.stringify(h.sent[restartAt - 1]);
    const after = JSON.stringify(h.sent[restartAt]);
    expect(before).toContain('verify the module boundary');
    expect(after).not.toContain('verify the module boundary');
    // And the rebuild really is a fresh two-message conversation.
    expect((h.sent[restartAt] as unknown[]).length).toBe(2);
  });

  it('stops honestly once the restart budget is spent, and names the restarts', async () => {
    // Never converges: burns both restarts, then falls through to the terminal stop.
    const { history, receipts } = await drive(60, {
      content: '',
      reasoning: RUMINATION,
      toolCalls: [{ id: 'z', name: 'noop', args: {} }],
    });
    expect(receipts.filter(r => r.includes('restarting'))).toHaveLength(2);
    const final = history[history.length - 1];
    expect(final.role).toBe('assistant');
    expect(final.role === 'assistant' && final.content).toMatch(/restarted 2 times/i);
  });
});
