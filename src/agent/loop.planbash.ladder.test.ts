import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The withdrawal ladder's half of #109. `isInspectionEscape` is unit-tested in tools/_readonly.test.ts;
// what this file pins is the WIRING — that the ladder calls the wide predicate and not plan mode's
// strict one. Swapping loop.ts back to `isProvablyReadOnly` leaves every classifier test green and
// silently reopens the `sed -n`/`awk` escape, so the assertion has to run through real dispatch.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

// A read that returns identical bytes every round: same path, same offset, same contentHash, which
// is exactly what ReadTrace scores as a loop. Two active rounds arms the withdrawal.
const stubRead: Tool = {
  name: 'read',
  description: 'read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  run: async () => ({ summary: 'Read app.ts (1-50)', payload: 'same bytes', contentHash: 'h1' }),
};

// Must actually run if it is ever dispatched, so a test that expects a refusal cannot pass by the
// command merely failing.
const stubBash: Tool = {
  name: 'bash',
  description: 'run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  run: async args => ({ summary: `Ran: ${String(args.command)}`, exitCode: 0 }),
};

const readRound = (n: number): ModelResponse => ({
  content: '',
  toolCalls: [{ id: `r${n}`, name: 'read', args: { path: 'app.ts', offset: 1 } }],
});
const bashRound = (command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
});

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
    maxTurns: 12,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
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
    sandbox: false,
  };
}

// Loop on the same read long enough to arm withdrawal, then make the bash call under test.
//
// The timing is load-bearing, so it is spelled out rather than padded: with LOOP_LIVE_REPEATS=2 the
// repeat is confirmed at round 2 (loopActiveRounds=1) and withdrawal arms at round 3
// (LOOP_WITHDRAW_AFTER=2). A withdrawn read is refused and therefore never recorded, so the trace
// stops advancing and the loop ages out of LOOP_RECENT_ROUNDS=2 by round 5 — withdrawal is live only
// at rounds 3 and 4. Four reads puts the bash call at round 4, inside that window.
async function runWithEscape(command: string): Promise<Message[]> {
  h.scripted.length = 0;
  for (let n = 0; n < 4; n++) h.scripted.push(readRound(n));
  h.scripted.push(bashRound(command));
  h.scripted.push({ content: 'done', toolCalls: undefined });
  const messages: Message[] = [];
  await runTurn({
    userInput: 'fix the bug',
    history: [],
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [stubRead, stubBash],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
  });
  return messages;
}

const bashSummaries = (messages: Message[]): string[] =>
  messages.flatMap(m => (m.role === 'tool' && m.summary.includes('Ran:') ? [m.summary] : []));

describe('withdrawal ladder still catches bash-shaped inspection (#109 regression)', () => {
  // The shapes the #109 rewrite dropped. Each is a line-range read: plan mode refuses to ADMIT them
  // (their program argument can write), but the ladder must still REFUSE them as an escape, which is
  // the opposite polarity on the same command. Before the predicate split these ran.
  it.each(["sed -n '1,50p' app.ts", "awk '{print $1}' app.ts", 'tree src'])(
    'refuses %s once inspection is withdrawn',
    async cmd => {
      const messages = await runWithEscape(cmd);
      expect(bashSummaries(messages)).toHaveLength(0);
    },
  );

  it.each(['grep -n foo app.ts | head -20', 'cat app.ts | tail -30'])(
    'still refuses the shapes it always caught: %s',
    async cmd => {
      const messages = await runWithEscape(cmd);
      expect(bashSummaries(messages)).toHaveLength(0);
    },
  );

  // The ladder's expensive mistake is refusing real work. A build or a mutation must run even at
  // full withdrawal — that is what makes the escape refusal safe to apply unconditionally.
  it.each(['npm run build', 'sed -i "s/x/y/" app.ts', 'git commit -m wip'])(
    'lets real work through at full withdrawal: %s',
    async cmd => {
      const messages = await runWithEscape(cmd);
      expect(bashSummaries(messages)).toEqual([`Ran: ${cmd}`]);
    },
  );
});
