import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The gate consts CONVERGE_RETRY / REASONING_LOOP_BREAK are read at loop.js import time, so the
// flags must be set before the import. Regression test for #83: the agent-mode converge steer
// was appended to `system` BEFORE the steady/ledger composition, whose reassignment silently
// discarded it — so from its introduction (585a438) the steered round ran unsteered while the
// "Still looping" receipt claimed otherwise. This drives a real runTurn into the reasoning-loop
// terminal and asserts the steer actually reaches the dispatched request.
const PRIOR_CONVERGE = process.env.REIKA_CONVERGE_RETRY;
const PRIOR_RLOOP = process.env.REIKA_REASONING_LOOP;
process.env.REIKA_CONVERGE_RETRY = '1';
process.env.REIKA_REASONING_LOOP = '1';
afterAll(() => {
  if (PRIOR_CONVERGE === undefined) delete process.env.REIKA_CONVERGE_RETRY;
  else process.env.REIKA_CONVERGE_RETRY = PRIOR_CONVERGE;
  if (PRIOR_RLOOP === undefined) delete process.env.REIKA_REASONING_LOOP;
  else process.env.REIKA_REASONING_LOOP = PRIOR_RLOOP;
});

// System snapshotted at call time; runTurn keeps mutating shared state after each call.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  systems: [] as string[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { system: string }) => {
    h.systems.push(opts.system);
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn, buildConvergeSteer } = await import('./loop.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
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
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

// A non-inspection tool, so the loop-break withdrawal (read/grep/glob/list) can't remove the
// model's escape hatch and the spiral can run all the way to the terminal.
const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Long enough for 8-gram shingles; byte-identical every round → crossSim 1.0, the observed
// rumination signature. Detection arms after round 1; ledger → withdrawal → terminal puts the
// steered round at call index 4.
const RUMINATION =
  'I need to check whether the helper is exported before I can change the call site, and to do ' +
  'that I should verify the module boundary once more before committing to any concrete edit at all.';

function spiralRound(): ModelResponse {
  return {
    content: '',
    reasoning: RUMINATION,
    toolCalls: [{ id: `c${h.scripted.length}`, name: 'noop', args: {} }],
  };
}

describe('agent-mode converge retry (#83 regression)', () => {
  it('the steer reaches the dispatched system on the steered round, once, on top of the ledger', async () => {
    h.systems.length = 0;
    h.scripted.length = 0;
    // Rounds 0-3 spiral; the steered round (4) converges cleanly.
    for (let n = 0; n < 4; n++) h.scripted.push(spiralRound());
    h.scripted.push({ content: 'converged: made the change', toolCalls: undefined });

    const history: Message[] = [];
    const receipts: string[] = [];
    await runTurn({
      userInput: 'fix the bug',
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

    const steer = buildConvergeSteer();
    const steered = h.systems.filter(s => s.includes(steer));
    // Exactly one steered round (MAX_CONVERGE_RETRIES=1), and it's the terminal round, not an
    // early one.
    expect(steered).toHaveLength(1);
    expect(h.systems.indexOf(steered[0])).toBe(4);
    // The steer rides ON TOP of the composed system: the loop ledger is still present and the
    // steer is the outermost (trailing) directive — the #83 clobber replaced it instead.
    expect(steered[0].endsWith(steer)).toBe(true);
    expect(steered[0]).toContain('what is still blocking you');
    // The receipt and the steered request now agree (the receipt used to fire unsteered).
    expect(receipts.filter(r => r.includes('Still looping'))).toHaveLength(1);
    // The turn still commits the steered round's answer.
    expect(history.at(-1)).toMatchObject({ role: 'assistant' });
    expect((history.at(-1) as { content: string }).content).toContain('converged');
  });
});
