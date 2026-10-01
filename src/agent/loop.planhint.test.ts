import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import type { PromptMode } from './prompt.js';

// The end-of-plan handoff hint (#614): a plan-mode turn ends with the plan, and the two ways out of
// that state — /implement (which hands THIS plan to another mode as a fresh turn) and a mode switch
// — are not visible in the plan text. Checked against the real runTurn loop, since the cells that
// matter are the loop's own: isFinal, the allowRefine gate that marks vibe's plan phase, and the
// 0-steps-is-not-a-plan line (#126) a force-written spiral stop sits on the wrong side of.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 6,
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

const PLAN_STEP = '1. Edit `src/theme.ts` to add the dark palette.';

// One plan-mode turn over a fresh history, scripted with `reply`. Returns everything the loop sent
// the human (onMessage) plus the model-facing history it ended with.
async function planTurn(
  reply: string,
  init: { promptMode?: PromptMode; allowRefine?: boolean; history?: Message[] } = {},
): Promise<{ messages: Message[]; history: Message[] }> {
  const history = init.history ?? [];
  const messages: Message[] = [];
  h.scripted.push({ content: reply, toolCalls: undefined });
  await runTurn({
    userInput: 'add a dark mode toggle',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [],
    payloads: new PayloadStore(),
    promptMode: init.promptMode ?? 'plan',
    ...(init.allowRefine === undefined ? {} : { allowRefine: init.allowRefine }),
    onMessage: m => messages.push(m),
  });
  return { messages, history };
}

const notices = (messages: Message[]): string[] =>
  messages.filter(m => m.role === 'system').map(m => (m as { content: string }).content);

describe('end-of-plan handoff hint (#614)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });

  it('follows a written plan, naming /implement and the modes it can be handed to', async () => {
    const { messages } = await planTurn(PLAN_STEP);
    const last = messages[messages.length - 1];
    // `emphasis: 'lead'` is what tints "Plan ready" in the info color (Scrollback's noticeLead):
    // the turn's call to action, not one more muted line.
    expect(last).toMatchObject({ role: 'system', tone: 'info', emphasis: 'lead' });
    const content = (last as { content: string }).content;
    expect(content).toContain('/implement');
    // Every mode the /implement picker offers, since switching to one is the other route out —
    // keep in step with IMPLEMENT_MODES (ui/commands.ts).
    for (const mode of ['/agent', '/minimal', '/grind']) expect(content).toContain(mode);
  });

  it('stays user-facing — it never enters the model history', async () => {
    const { history } = await planTurn(PLAN_STEP);
    expect(history.some(m => m.role === 'system')).toBe(false);
    // The plan itself is the last thing the model sees.
    expect(history[history.length - 1]).toMatchObject({ role: 'assistant', planFinal: true });
  });

  // #126: `planFinal` marks the end of a plan turn, not the existence of a plan. A turn that
  // dead-ends in prose has nothing to hand off, so the hint must not promise an /implement.
  it('does not promise /implement over a step-less final message', async () => {
    const { messages, history } = await planTurn('I could not decide how to approach this.');
    expect(history[history.length - 1]).toMatchObject({ role: 'assistant', planFinal: true });
    expect(notices(messages).join('\n')).not.toContain('/implement');
  });

  // Vibe's plan phase runs as an ordinary plan turn (turnPromptMode maps vibe to 'plan') and is
  // marked only by allowRefine false: its plan is implemented by the harness straight after, so
  // naming /implement would point at a step already taken.
  it("does not on vibe's plan phase", async () => {
    const { messages } = await planTurn(PLAN_STEP, { allowRefine: false });
    expect(notices(messages).join('\n')).not.toContain('/implement');
  });

  it('does not in agent mode', async () => {
    const { messages } = await planTurn(PLAN_STEP, { promptMode: 'agent' });
    expect(notices(messages).join('\n')).not.toContain('/implement');
  });

  // A refinement that changed nothing already reports itself; the handoff hint follows it as the
  // last line of the turn, and is the only one of the two that names /implement.
  it('follows the no-op refinement warning without repeating it', async () => {
    const { messages } = await planTurn(PLAN_STEP, {
      history: [{ role: 'assistant', content: PLAN_STEP, planFinal: true }],
    });
    const said = notices(messages);
    const at = (needle: string) => said.findIndex(s => s.includes(needle));
    expect(said.some(s => s.includes('Plan unchanged'))).toBe(true);
    expect(said[at('Plan unchanged')]).not.toContain('/implement');
    expect(at('Plan unchanged')).toBeLessThan(at('/implement'));
    expect(said[said.length - 1]).toContain('/implement');
  });
});
