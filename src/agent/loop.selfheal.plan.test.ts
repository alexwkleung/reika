import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// Plan mode reaches the self-healing restart only through the verbatim-abort dead end (the sole
// commitSpiralStop call site), which means it needs a STREAMING mock — the abort is decided inside
// onReasoningDelta, not from the returned response. That's why this lives apart from
// loop.selfheal.test.ts, which mocks a non-streaming call.
//
// What it pins: a restart in plan mode restarts PLANNING. Every counter that decides "force-write
// instead of explore" is per-turn, so leaving one set makes the restart's first round a second
// transform over a digest rather than the fresh state the rung exists to provide.
const PRIOR = {
  heal: process.env.REIKA_SELF_HEAL,
  rloop: process.env.REIKA_REASONING_LOOP,
  verbatim: process.env.REIKA_VERBATIM_ABORT,
  converge: process.env.REIKA_CONVERGE_RETRY,
  logit: process.env.REIKA_LOGIT_RECOVERY,
};
process.env.REIKA_SELF_HEAL = '1';
process.env.REIKA_REASONING_LOOP = '1';
process.env.REIKA_VERBATIM_ABORT = '1';
// Off so the restart is the rung reached at the dead end rather than the steered retry.
delete process.env.REIKA_CONVERGE_RETRY;
delete process.env.REIKA_LOGIT_RECOVERY;
afterAll(() => {
  for (const [k, v] of [
    ['REIKA_SELF_HEAL', PRIOR.heal],
    ['REIKA_REASONING_LOOP', PRIOR.rloop],
    ['REIKA_VERBATIM_ABORT', PRIOR.verbatim],
    ['REIKA_CONVERGE_RETRY', PRIOR.converge],
    ['REIKA_LOGIT_RECOVERY', PRIOR.logit],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Scripted = ModelResponse & { streamReasoning?: string };

const h = vi.hoisted(() => ({ scripted: [] as unknown[], sent: [] as unknown[][] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(
    async (opts: {
      history: unknown[];
      signal?: AbortSignal;
      onReasoningDelta?: (t: string) => void;
    }) => {
      h.sent.push(JSON.parse(JSON.stringify(opts.history)));
      const next = (h.scripted.shift() as Scripted) ?? { content: 'done', toolCalls: undefined };
      // Stream the reasoning in chunks so the loop's live spin/ceiling check runs, and stop the
      // moment it aborts — exactly what the real streaming call does.
      if (next.streamReasoning) {
        for (let n = 0; n < next.streamReasoning.length; n += 1000) {
          if (opts.signal?.aborted) break;
          opts.onReasoningDelta?.(next.streamReasoning.slice(n, n + 1000));
        }
      }
      return { content: next.content, reasoning: next.reasoning, toolCalls: next.toolCalls };
    },
  ),
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

// Not in TRACKED_TOOLS, so it never grows the novelty watermark — each round it runs is a stale
// round, which is how the script drives planStaleRounds to the force-write threshold.
const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Long enough to trip the force-write reasoning ceiling (12k chars) on its own, regardless of
// repetition ratio — the length gate is the deterministic half of the abort.
const RUNAWAY = 'the module boundary needs one more check before I commit to anything. '.repeat(
  300,
);

const exploreRound = (id: string): Scripted => ({
  content: '',
  reasoning: 'short',
  toolCalls: [{ id, name: 'noop', args: {} }],
});

async function drive(script: Scripted[]) {
  h.scripted.length = 0;
  h.sent.length = 0;
  h.scripted.push(...script);
  const history: Message[] = [];
  const receipts: string[] = [];
  await runTurn({
    userInput: 'plan the retry/backoff work for the fetch helper',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [noop],
    payloads: new PayloadStore(),
    onMessage: m => {
      if (m.role === 'system') receipts.push(m.content);
    },
    promptMode: 'plan',
  });
  return { history, receipts };
}

describe('self-healing restart in plan mode (#137)', () => {
  it('restarts planning rather than force-writing over the digest', async () => {
    const { receipts } = await drive([
      exploreRound('a'), // stale round 1
      exploreRound('b'), // stale round 2 → planStaleRounds hits PLAN_STALL_ROUNDS
      { content: '', toolCalls: undefined, streamReasoning: RUNAWAY }, // force-write spirals → restart
      { content: 'the plan', toolCalls: undefined }, // whatever the restart is given, it answers
    ]);
    expect(receipts.some(r => r.includes('restarting'))).toBe(true);

    // The request sent immediately after the restart. A plan FORCE-WRITE is a synthetic single-user
    // -message transform (no history, no tools); ordinary exploration sends the real conversation.
    // The rebuilt conversation is [digest, request], so length 2 with a compaction head is the
    // signature of "explored again", and length 1 is the signature of "force-wrote immediately".
    const afterRestart = h.sent.find(
      ms => (ms as { role: string }[])[0]?.role === 'compaction',
    ) as { role: string }[];
    expect(afterRestart).toBeDefined();
    expect(afterRestart.length).toBe(2);
    expect(afterRestart[1].role).toBe('user');
  });

  it('re-arms the mid-stream reasoning cut after a restart', async () => {
    // The restart budget is the OUTERMOST cap, so every guard inside it re-arms. Leaving the
    // verbatim-abort budget spent would hand the model a clean conversation and simultaneously
    // remove the thing that cuts a runaway block — the restarted turn would run to the token wall.
    const { receipts } = await drive([
      exploreRound('a'),
      { content: '', toolCalls: undefined, streamReasoning: RUNAWAY }, // cut 1 → force-write next
      { content: '', toolCalls: undefined, streamReasoning: RUNAWAY }, // cut 2 → budget spent → restart
      { content: '', toolCalls: undefined, streamReasoning: RUNAWAY }, // post-restart runaway
      { content: 'the plan', toolCalls: undefined },
    ]);
    const restartAt = receipts.findIndex(r => r.includes('restarting'));
    expect(restartAt).toBeGreaterThanOrEqual(0);
    const cutAfterRestart = receipts
      .slice(restartAt + 1)
      .some(r => r.includes('Reasoning was repeating itself'));
    expect(cutAfterRestart).toBe(true);
  });
});
