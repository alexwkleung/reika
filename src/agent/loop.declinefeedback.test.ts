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

type Gated = { seen: unknown; summary: string; followUp?: Message; shown: Message[] };

async function runGated(answer: ApprovalAnswer): Promise<Gated> {
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
  const shown: Message[] = [];
  await runTurn({
    userInput: 'run the tests',
    history,
    bundle,
    config,
    tools: [gated],
    payloads: new PayloadStore(),
    onMessage: m => shown.push(m),
    requestApproval: async () => answer,
  });
  const at = history.findIndex(m => m.role === 'tool');
  const tool = history[at];
  return {
    seen,
    summary: tool && tool.role === 'tool' ? tool.summary : '',
    followUp: history[at + 1],
    shown,
  };
}

describe('decline with feedback', () => {
  it('hands the tool false, quotes the reason, and sends it as the user right after', async () => {
    const r = await runGated({ feedback: 'tell me the script' });
    expect(r.seen).toBe(false);
    expect(r.summary).toBe('Bash declined by user: npm test\nThe user wrote: "tell me the script"');
    // A user message, not text in the tool result, and not a turn boundary (#287).
    expect(r.followUp).toEqual({ role: 'user', content: 'tell me the script', harness: true });
    // History only: the row already shows the quote, so the scrollback gets no second copy.
    expect(r.shown.some(m => m.role === 'user' && m.content === 'tell me the script')).toBe(false);
  });

  it('leaves a plain decline and an approval unchanged, with no follow-up message', async () => {
    const declined = await runGated(false);
    expect(declined.seen).toBe(false);
    expect(declined.summary).toBe('Bash declined by user: npm test');
    expect(declined.followUp?.role).not.toBe('user');
    const approved = await runGated(true);
    expect(approved.seen).toBe(true);
    expect(approved.summary).toBe('Ran: npm test');
    expect(approved.followUp?.role).not.toBe('user');
  });
});
