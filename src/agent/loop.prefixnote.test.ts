import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// End-to-end wiring for the `trailing-note` divergence cause (#253). Under REIKA_PREFIX_STABLE the
// per-round harness note rides the final message slot, so the NEXT round's append lands on it and
// the byte comparison sees a divergence there — a real one, but a fixed-size tail, not history
// churn. Reported as `mid-history firstChanged=assistant` it read as payload aging invalidating the
// cache on every single round, which is the opposite of what the mode was doing: on the 24k run the
// issue was filed from, that "churn" was a constant 436 chars and ~46s across 2h15m, while the
// actual cost sat in three shrink events.
//
// A unit test on PrefixTrace can't catch a loop that never passes the flag, so this drives runTurn
// and serializes through the REAL messagesToChatParams — the note's position in the request is the
// whole premise, and a hand-built message list would just re-assert it.
const PRIOR: Record<string, string | undefined> = {};
for (const k of [
  'REIKA_PREFIX_STABLE',
  'REIKA_DROPPED_LEDGER',
  'REIKA_DEBUG',
  'REIKA_DEBUG_FILE',
]) {
  PRIOR[k] = process.env[k];
}
process.env.REIKA_PREFIX_STABLE = '1';
process.env.REIKA_DROPPED_LEDGER = '1';
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  for (const [k, v] of Object.entries(PRIOR)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', async () => {
  const { messagesToChatParams: toChatParams } = await import('../provider/toolcall.js');
  return {
    // Mirrors client.ts's own composition so onRequest sees the bytes a real call would send.
    callModel: vi.fn(
      async (opts: {
        system: string;
        history: Message[];
        config: Config;
        prefixStable?: boolean;
        trailingNote?: string;
        onRequest?: (m: unknown[]) => void;
      }) => {
        opts.onRequest?.(
          toChatParams(opts.system, opts.history, {
            contextWindow: opts.config.contextWindow,
            reasoningRounds: opts.config.reasoningRounds,
            minGenTokens: opts.config.minGenTokens,
            prefixStable: opts.prefixStable,
            stampRenders: opts.prefixStable,
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
    // prefix-stable is inert without a known window.
    contextWindow: 16384,
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

const noopTool: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// An aged payload in the prior turn is what keeps the dropped-payload ledger — and therefore the
// trailing note — present on every round of this turn. Without a note there is nothing to displace.
function agedPriorTurn(): Message[] {
  return [
    { role: 'user', content: 'earlier work' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
    },
    {
      role: 'tool',
      callId: 'c1',
      summary: 'Ran: noop (505 bytes output)',
      payload: 'BODY',
      aged: true,
    },
    { role: 'assistant', content: 'done that.' },
  ];
}

describe('trailing-note divergence cause under REIKA_PREFIX_STABLE (#253)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-prefixnote-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the note slot on a pure-append round instead of blaming mid-history', async () => {
    // Round 0 calls a tool; round 1 is that result appended and nothing else — the cleanest possible
    // append, and the round that used to report as history churn.
    h.scripted.push({ content: '', toolCalls: [{ id: 'n1', name: 'noop', args: {} }] });
    h.scripted.push({ content: 'final', toolCalls: undefined });

    const history = agedPriorTurn();
    await runTurn({
      userInput: 'do the thing',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [noopTool],
      payloads: new PayloadStore(),
      onMessage: () => {},
    });

    const log = await readFile(logPath, 'utf8');
    const lines = log.split('\n').filter(l => l.includes('] prefix-cache round='));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // The note really was sent — otherwise this test would pass for the wrong reason.
    expect(log).toContain('dropped-ledger active=true');
    expect(lines[0]).toContain('cause=first-request');
    expect(lines[1]).toContain('cause=trailing-note');
    // The role that displaced the note is exactly the misreading the cause replaces.
    expect(lines[1]).not.toContain('firstChanged=');
    // Naming the cause must not understate the cost: those bytes are still charged as diverged.
    const [, stable, total] = /stable=(\d+)\/(\d+)c/.exec(lines[1]!)!;
    expect(Number(stable)).toBeLessThan(Number(total));
  });
});
