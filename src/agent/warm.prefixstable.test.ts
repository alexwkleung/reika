import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { messagesToOpenAI } from '../provider/toolcall.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import type { PromptMode } from './prompt.js';

// The gate const PREFIX_STABLE is read at loop.js import time, so the flag must be set before
// the import. Under REIKA_PREFIX_STABLE the per-round ledgers ride the transient trailing note
// instead of the system block, so the round-0 system is the bare base prompt — this file locks
// the warm prefix (buildRoundZeroPrefix) to runTurn's round 0 under that regime, the flag-on
// counterpart of the drift tests in warm.test.ts.
const PRIOR = process.env.REIKA_PREFIX_STABLE;
process.env.REIKA_PREFIX_STABLE = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_PREFIX_STABLE;
  else process.env.REIKA_PREFIX_STABLE = PRIOR;
});

// Full request opts snapshotted at call time (runTurn mutates the history array after the call);
// trailingNote/prefixStable are captured so the comparison serializes exactly what client.ts would.
const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  captured: [] as {
    system: string;
    history: Message[];
    prefixStable?: boolean;
    trailingNote?: string;
  }[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(
    async (opts: {
      system: string;
      history: Message[];
      prefixStable?: boolean;
      trailingNote?: string;
    }) => {
      h.captured.push({
        system: opts.system,
        history: opts.history.slice(),
        prefixStable: opts.prefixStable,
        trailingNote: opts.trailingNote,
      });
      return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
    },
  ),
}));

const { runTurn } = await import('./loop.js');
const { buildWarmPayload } = await import('./warm.js');

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
    // prefixStableActive needs a window (sticky watermarks); this also exercises the frozen-byte
    // serialization path rather than the no-cap fallback.
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
  };
}

function priorTurn(): Message[] {
  return [
    { role: 'user', content: 'look at a.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: 'const a = 1;'.repeat(10) },
    { role: 'assistant', content: 'a.ts defines a.' },
  ];
}

// Serialize the way client.ts does for a prefix-stable request, WITHOUT stamping (comparison
// only — the bytes are identical either way, stamping merely persists them).
const serialize = (c: Config, system: string, history: Message[], trailingNote?: string) =>
  messagesToOpenAI(system, history, {
    contextWindow: c.contextWindow,
    calibration: 1,
    reasoningRounds: c.reasoningRounds,
    minGenTokens: c.minGenTokens,
    prefixStable: true,
    trailingNote,
  });

async function captureRoundZero(history: Message[], promptMode: PromptMode, config: Config) {
  h.scripted.push({ content: 'final', toolCalls: undefined });
  await runTurn({
    userInput: 'do the thing',
    history,
    bundle: makeBundle(),
    config,
    tools: [],
    payloads: new PayloadStore(),
    onMessage: () => {},
    promptMode,
  });
  return h.captured[0];
}

describe('warm prefix under REIKA_PREFIX_STABLE', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.captured.length = 0;
  });

  for (const promptMode of ['agent', 'plan'] as const) {
    it(`round-0 system is the bare base prompt and the warm is a strict prefix (${promptMode})`, async () => {
      const config = makeConfig();
      const preTurn = priorTurn();
      const warm = buildWarmPayload({
        history: preTurn,
        bundle: makeBundle(),
        config,
        tools: [],
        promptMode,
        calibration: 1,
      });
      const real = await captureRoundZero(preTurn.slice(), promptMode, config);

      // The real call runs under the flag, and its system carries no ledger — byte-equal to the
      // warm's. (Plan mode's exploration ledger rides the trailing note instead.)
      expect(real.prefixStable).toBe(true);
      expect(warm.system).toBe(real.system);
      if (promptMode === 'plan') {
        expect(real.system).not.toContain('plan-mode status');
        expect(real.trailingNote).toContain('plan-mode status');
      } else {
        expect(real.trailingNote).toBeUndefined();
      }

      const warmMsgs = serialize(config, warm.system, warm.history);
      const realMsgs = serialize(config, real.system, real.history, real.trailingNote);
      // Real request = warm request + user message (+ trailing note in plan mode) — the warm
      // prefix survives intact, which is the whole point under this flag.
      expect(realMsgs.length).toBe(warmMsgs.length + (real.trailingNote ? 2 : 1));
      expect(realMsgs.slice(0, warmMsgs.length)).toEqual(warmMsgs);
    });
  }

  it('never mutates the caller history (no aged/rendered stamps from a warm)', () => {
    const history = priorTurn();
    const before = structuredClone(history);
    buildWarmPayload({
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      promptMode: 'agent',
      calibration: 1,
    });
    expect(history).toEqual(before);
  });
});
