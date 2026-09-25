import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// Plan refinement (#46): a plan-mode turn that follows a written plan REVISES it, rather than
// deriving a new plan from the request. Two places carry that, and both are checked here against
// the real runTurn loop where the wiring lives:
//   - the plan-mode ledger (every round), which tells the model to revise rather than re-derive;
//   - the force-write transform, which REPLACES the history — so it must carry the previous plan
//     and the newest thing the user asked for, or the revision round silently rebuilds the plan
//     from the original request;
//   - the no-op receipt, so a revision that changed nothing is visible to the user rather than
//     looking exactly like one that absorbed the request.
// The derivation itself (`refineTarget`) is unit-tested in plantrack.test.ts; the parts checked
// here are the ones that need the loop's history state — above all that the refinement is resolved
// from the history the turn STARTED with, since the turn's own messages would otherwise disqualify
// it half-way through.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn, buildSteadySystem, buildPlanTransformInput, buildPlanWritePrompt } =
  await import('./loop.js');
const { callModel } = await import('../provider/client.js');
const { refineTarget } = await import('./plantrack.js');

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

// A finished plan-mode turn: request, one read round, the written plan.
const PLAN_STEP = '1. Edit `src/theme.ts` to add the dark palette.';
function plannedHistory(): Message[] {
  return [
    { role: 'user', content: 'add a dark mode toggle' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'src/theme.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'Read src/theme.ts', payload: 'PALETTE BYTES' },
    { role: 'assistant', content: PLAN_STEP, planFinal: true },
  ];
}

describe('plan refinement turn (#46)', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });

  // The plan ledger rides the system block normally, and the transient trailing note under
  // REIKA_PREFIX_STABLE (on by default, and active here because the config knows a window) — the
  // same helper composes it either way, so the assertion reads whichever the round actually sent.
  const sentLedgerText = (call = 0): string => {
    const req = vi.mocked(callModel).mock.calls[call]?.[0];
    return `${req?.system ?? ''}\n${req?.trailingNote ?? ''}`;
  };

  it('tells the model to revise the plan above on a plan-mode follow-up', async () => {
    const history = plannedHistory();
    h.scripted.push({
      content: '1. Edit `src/theme.ts`.\n2. Edit `src/ui/Settings.tsx`.',
      toolCalls: undefined,
    });
    await runTurn({
      userInput: 'also cover the settings screen',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'plan',
      onMessage: () => {},
    });
    const sent = sentLedgerText();
    expect(sent).toContain('This turn refines it');
    expect(sent).toContain('LIVE plan');
    // The revised plan is a fresh planFinal message, so the handoff/checklist/`/implement` all
    // anchor on the newest one — no new mechanism for superseding the old plan.
    const last = history[history.length - 1];
    expect(last).toMatchObject({ role: 'assistant', planFinal: true });
    expect((last as { content: string }).content).toContain('Settings.tsx');
  });

  // The fallback half of #46: a weak model handed "also cover the settings screen" can re-emit the
  // plan it already had. Without this the user sees a fresh plan turn and has no way to tell it
  // apart from one that absorbed the request.
  const revisionNotice = (messages: Message[]): string =>
    messages
      .filter((m): m is Message & { role: 'system' } => m.role === 'system')
      .map(m => m.content)
      .join('\n');

  async function refine(previousPlan: string, reply: string): Promise<Message[]> {
    const history = plannedHistory();
    (history[history.length - 1] as { content: string }).content = previousPlan;
    const messages: Message[] = [];
    h.scripted.push({ content: reply, toolCalls: undefined });
    await runTurn({
      userInput: 'also cover the settings screen',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'plan',
      onMessage: m => messages.push(m),
    });
    return messages;
  }

  it('says so when the revision changed nothing', async () => {
    const messages = await refine(PLAN_STEP, PLAN_STEP);
    expect(revisionNotice(messages)).toContain('Plan unchanged');
  });

  it('stays quiet when the revision changed the plan, renumbered or not', async () => {
    // Same steps, rewritten numbering and heading: still a change of nothing — the comparison is on
    // the parsed step text, not the bytes.
    expect(revisionNotice(await refine(PLAN_STEP, `Plan:\n\n1) ${PLAN_STEP.slice(3)}`))).toContain(
      'Plan unchanged',
    );
    expect(
      revisionNotice(await refine(PLAN_STEP, '1. Edit `src/ui/Settings.tsx` for the new toggle.')),
    ).not.toContain('Plan unchanged');
  });

  it('does not on a first planning pass', async () => {
    const history: Message[] = [];
    h.scripted.push({ content: PLAN_STEP, toolCalls: undefined });
    await runTurn({
      userInput: 'add a dark mode toggle',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'plan',
      onMessage: () => {},
    });
    expect(sentLedgerText()).not.toContain('This turn refines it');
  });

  it('does not when the plan is followed by another model turn (a vibe chain, not a follow-up)', () => {
    // Vibe runs the implementation turn off the same prompt, so the next vibe prompt is a new task
    // whose plan merely happens to sit earlier in the shared history. The implementation's own
    // assistant message is what distinguishes it.
    const history: Message[] = [
      ...plannedHistory(),
      { role: 'user', content: 'implement the plan above' },
      { role: 'assistant', content: 'Done — the toggle is in place.' },
      { role: 'user', content: 'now add a settings screen' },
    ];
    const ledger = buildSteadySystem({
      baseSystem: 'BASE',
      promptMode: 'plan',
      history,
      round: 0,
      planSteps: null,
    });
    expect(ledger).not.toContain('This turn refines it');
  });

  it("does not on vibe's plan phase (allowRefine: false) even with the plan right above", async () => {
    // The case the "last thing the model said" rule cannot tell from a follow-up: a vibe prompt
    // whose plan phase directly follows a written plan (a /plan → /vibe switch, or a chat detour
    // and back). The front end gates it off (ui/commands.ts turnRefines → allowRefine); the loop
    // obeys and reads the turn as a fresh planning pass, so a new task cannot absorb the earlier
    // chain's steps.
    const history = plannedHistory();
    const messages: Message[] = [];
    // The reply re-emits the very plan above: a refinement turn would flag "Plan unchanged", but a
    // fresh planning pass legitimately produced a plan and must not.
    h.scripted.push({ content: PLAN_STEP, toolCalls: undefined });
    await runTurn({
      userInput: 'now plan the release script',
      history,
      bundle: makeBundle(),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'plan',
      allowRefine: false,
      onMessage: m => messages.push(m),
    });
    expect(sentLedgerText()).not.toContain('This turn refines it');
    expect(revisionNotice(messages)).not.toContain('Plan unchanged');
  });

  it('resolves the refinement from the pre-turn history, not the growing one', () => {
    const preTurn = plannedHistory();
    const refine = refineTarget(preTurn);
    expect(refine).not.toBeNull();
    // Mid-turn H, the turn has added its own assistant tool-call message: a fresh derivation would
    // now see the plan as "not the last thing the model said" and drop the refinement from the
    // ledger — so the loop resolves it once and passes it down.
    const midTurn: Message[] = [
      ...preTurn,
      { role: 'user', content: 'also cover the settings screen' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'read', args: { path: 'a.ts' } }],
      },
    ];
    const derived = buildSteadySystem({
      baseSystem: 'BASE',
      promptMode: 'plan',
      history: midTurn,
      round: 1,
      planSteps: null,
    });
    expect(derived).not.toContain('This turn refines it');
    const carried = buildSteadySystem({
      baseSystem: 'BASE',
      promptMode: 'plan',
      history: midTurn,
      round: 1,
      planSteps: null,
      refine,
    });
    expect(carried).toContain('This turn refines it');
  });
});

describe('the force-write transform carries the refinement (#46)', () => {
  // The transform replaces the whole history with one synthetic message, so the previous plan and
  // the newest user message must both be named in it. The pre-existing path put the plan only in
  // `gatherPlanAnalysis` — mixed with everything else, truncated to a 4000-char tail, and dropped
  // outright on a loop-triggered force-write.
  it('carries the plan and the latest request', () => {
    const history: Message[] = [
      ...plannedHistory(),
      { role: 'user', content: 'also cover the settings screen' },
    ];
    const out = buildPlanTransformInput(history, 100000, false);
    expect(out).toContain('The plan you already wrote:');
    expect(out).toContain(PLAN_STEP);
    expect(out).toContain("The user's latest message (what to change):");
    expect(out).toContain('also cover the settings screen');
    expect(out).toContain('Write the whole updated plan now');
  });

  it('still carries them when the analysis is dropped (loop-triggered force-write)', () => {
    const history: Message[] = [
      ...plannedHistory(),
      { role: 'user', content: 'also cover the settings screen' },
    ];
    const out = buildPlanTransformInput(history, 100000, true);
    expect(out).not.toContain('Your analysis:');
    expect(out).toContain(PLAN_STEP);
    expect(out).toContain('also cover the settings screen');
  });

  it('carries the plan even when the turn has added its own messages since', () => {
    const preTurn = plannedHistory();
    const refine = refineTarget(preTurn);
    const midTurn: Message[] = [
      ...preTurn,
      { role: 'user', content: 'also cover the settings screen' },
      { role: 'assistant', content: 'Checking the settings screen.', reasoning: 'RUMINATION' },
    ];
    const out = buildPlanTransformInput(midTurn, 100000, false, refine);
    expect(out).toContain(PLAN_STEP);
    // The plan is carried once, verbatim — not also inside the analysis tail.
    expect(out.split(PLAN_STEP)).toHaveLength(2);
  });

  it('is unchanged on a fresh planning pass (no plan to carry)', () => {
    const history: Message[] = [
      { role: 'user', content: 'add a dark mode toggle' },
      { role: 'tool', callId: 'c1', summary: 'Read a.ts', payload: 'FILE CONTENTS HERE' },
    ];
    const out = buildPlanTransformInput(history, 100000, false);
    expect(out).not.toContain('The plan you already wrote:');
    expect(out).not.toContain("The user's latest message");
    expect(out).toContain('Write the numbered, file-specific plan for the request now');
  });
});

describe('buildPlanWritePrompt under refinement (#46)', () => {
  it('says to revise the plan it is given, and only then', () => {
    const p = buildPlanWritePrompt(false, true);
    expect(p).toContain('PLAN MODE'); // the base instruction still leads
    expect(p).toMatch(/already written/);
    expect(p).toMatch(/Do not start over/i);
    expect(buildPlanWritePrompt(false, false)).not.toMatch(/Do not start over/i);
  });

  it('keeps the converge-retry steer last, closest to generation', () => {
    const p = buildPlanWritePrompt(true, true);
    expect(p).toMatch(/Commit to ONE analysis/i);
    expect(p.indexOf('Commit to ONE analysis')).toBeGreaterThan(p.indexOf('Do not start over'));
  });
});
