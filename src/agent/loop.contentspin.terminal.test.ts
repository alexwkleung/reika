import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import type * as Transport from '../provider/transport.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The agent terminal's last-chance rounds (#944 review): the converge-steer round and the logit
// round are forced, and the round after either is the next step toward the loop stop rather than a
// retry. So a content-spin cut there must not fire — it would say "retrying" and then stop.
// The loop reads its flags at import, so each arm loads it fresh with its own pins.

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  // Content streamed through onContentDelta on the call at this index (0-based).
  streamAt: new Map<number, string>(),
  calls: 0,
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onContentDelta?: (t: string) => void }) => {
    const chunk = h.streamAt.get(h.calls++);
    if (chunk) {
      for (let i = 0; i < chunk.length; i += 1000) opts.onContentDelta?.(chunk.slice(i, i + 1000));
      return { content: chunk, toolCalls: undefined };
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));
// The logit round needs token ids; a real /tokenize request is not what this tests. One id per
// word, since a tool name's id is exempt from the bias and a shared id would leave nothing to bias.
vi.mock('../provider/transport.js', async importOriginal => {
  const ids = new Map<string, number>();
  return {
    ...(await importOriginal<typeof Transport>()),
    tokenize: vi.fn(async ({ content }: { content: string }) => {
      if (!ids.has(content)) ids.set(content, 1000 + ids.size);
      return [ids.get(content) as number];
    }),
  };
});

const PINNED = [
  'REIKA_CONVERGE_RETRY',
  'REIKA_LOGIT_RECOVERY',
  'REIKA_REASONING_LOOP',
  'REIKA_PREFIX_STABLE',
  'REIKA_CONTENT_SPIN',
] as const;
const PRIOR = Object.fromEntries(PINNED.map(k => [k, process.env[k]]));
afterAll(() => {
  for (const k of PINNED) {
    if (PRIOR[k] === undefined) delete process.env[k];
    else process.env[k] = PRIOR[k];
  }
});

async function loadLoop(env: { converge: boolean; logit: boolean }) {
  process.env.REIKA_CONVERGE_RETRY = env.converge ? '1' : '0';
  process.env.REIKA_LOGIT_RECOVERY = env.logit ? '1' : '0';
  process.env.REIKA_REASONING_LOOP = '1';
  process.env.REIKA_PREFIX_STABLE = '0';
  process.env.REIKA_CONTENT_SPIN = '1';
  vi.resetModules();
  return (await import('./loop.js')).runTurn;
}

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
    bashIdleMs: 5000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

// Not an inspection tool, so withdrawal leaves the model a call and the spiral reaches the terminal.
const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  parameters: { type: 'object', properties: {}, required: [] },
  run: async () => ({ summary: 'ok' }),
};

// Byte-identical reasoning every round: ledger → withdrawal → terminal puts the forced round at
// call index 4 (loop.converge.test.ts).
const RUMINATION =
  'I need to check whether the helper is exported before I can change the call site, and to do ' +
  'that I should verify the module boundary once more before committing to any concrete edit at all.';
const TERMINAL_CALL = 4;

function loopingContent(): string {
  return Array.from(
    { length: 170 },
    () =>
      'let me re-read the task again and check the fetch failed branch: the sandbox is blocking ' +
      'repeated reads, so maybe the message comes from callMcpTool rather than the tool result',
  ).join('\n\n');
}

async function runToTerminal(
  runTurn: Awaited<ReturnType<typeof loadLoop>>,
): Promise<{ notices: string[]; calls: number }> {
  for (let n = 0; n < TERMINAL_CALL; n++) {
    h.scripted.push({
      content: '',
      reasoning: RUMINATION,
      toolCalls: [{ id: `c${n}`, name: 'noop', args: {} }],
    });
  }
  h.streamAt.set(TERMINAL_CALL, loopingContent());
  const notices: string[] = [];
  await runTurn({
    userInput: 'fix the bug',
    history: [] as Message[],
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [noop],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => {
      if (m.role === 'system') notices.push(m.content);
    },
  });
  return { notices, calls: h.calls };
}

describe('content-spin cut on the agent terminal rounds', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    h.streamAt.clear();
    h.calls = 0;
  });

  it('does not cut the converge-steer round', async () => {
    const { notices, calls } = await runToTerminal(
      await loadLoop({ converge: true, logit: false }),
    );
    expect(notices.some(n => n.startsWith('Still looping'))).toBe(true);
    expect(notices.some(n => n.includes('Output was repeating'))).toBe(false);
    expect(calls).toBe(TERMINAL_CALL + 1);
  });

  it('does not cut the logit round', async () => {
    const { notices, calls } = await runToTerminal(
      await loadLoop({ converge: false, logit: true }),
    );
    expect(notices.some(n => n.startsWith('Recovering: nudging'))).toBe(true);
    expect(notices.some(n => n.includes('Output was repeating'))).toBe(false);
    expect(calls).toBe(TERMINAL_CALL + 1);
  });
});
