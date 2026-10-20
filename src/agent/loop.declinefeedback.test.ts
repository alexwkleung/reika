import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type {
  ApprovalAnswer,
  Config,
  ContextBundle,
  Message,
  Tool,
  ToolContext,
} from '../types.js';

// A decline with a reason: the tool must see a plain `false` (the `{ feedback }` object is truthy,
// and `if (!ok)` is how every gated tool reads its answer), and the reason must reach the model in
// the summary — the part of a tool message that survives aging. Through real dispatch, since the
// translation lives in the loop rather than in any tool.
const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: tmpdir(),
  hash: 'test',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'off',
  subagentMaxTurns: 5,
  profiles: {},
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

async function runGated(answer: ApprovalAnswer): Promise<{ seen: unknown; summary: string }> {
  let seen: unknown;
  const gated: Tool = {
    name: 'gated',
    description: 'asks first',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async (_args, ctx: ToolContext) => {
      const ok = await ctx.requestApproval!({
        tool: 'bash',
        subject: 'npm test',
        preview: 'npm test',
      });
      seen = ok;
      return { summary: ok ? 'Ran: npm test' : 'Bash declined by user: npm test' };
    },
  };
  h.scripted.push({ content: '', toolCalls: [{ id: 'a', name: 'gated', args: {} }] });
  const history: Message[] = [];
  await runTurn({
    userInput: 'run the tests',
    history,
    bundle,
    config,
    tools: [gated],
    payloads: new PayloadStore(),
    onMessage: () => {},
    requestApproval: async () => answer,
  });
  const tool = history.find(m => m.role === 'tool');
  return { seen, summary: tool && tool.role === 'tool' ? tool.summary : '' };
}

describe('decline with feedback', () => {
  it('hands the tool false and puts the reason in the summary', async () => {
    const { seen, summary } = await runGated({ feedback: 'use pnpm test instead' });
    expect(seen).toBe(false);
    expect(summary).toBe(
      'Bash declined by user: npm test\nThe user said what to do instead: use pnpm test instead',
    );
  });

  it('leaves a plain decline and an approval unchanged', async () => {
    expect(await runGated(false)).toEqual({
      seen: false,
      summary: 'Bash declined by user: npm test',
    });
    expect(await runGated(true)).toEqual({ seen: true, summary: 'Ran: npm test' });
  });
});
