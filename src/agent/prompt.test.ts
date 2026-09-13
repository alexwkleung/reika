import { afterEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { buildSystemPrompt } from './prompt.js';
import { defaultTools, planTools } from '../tools/index.js';
import type { ContextBundle } from '../types.js';

const bundle: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/repo',
  hash: 'h',
  fileIndex: [],
  ignore: ignore(),
  skills: [],
};

const planPrompt = (): string => buildSystemPrompt({ bundle, mode: 'plan' });
// Line wrapping is a formatting choice; the claims are what matter.
const planPromptFlat = (): string => planPrompt().replace(/\s+/g, ' ');

// The plan prompt states what plan mode CAN do. That claim is only true while it matches the tool
// list, and a model told a tool "will fail" will not reach for one that is actually there — so the
// two are asserted together rather than trusted to stay in step.
describe('plan prompt tracks planTools (#109)', () => {
  afterEach(() => {
    delete process.env.REIKA_PLAN_BASH;
  });

  it('says commands are unavailable while bash is not in the tool list', () => {
    delete process.env.REIKA_PLAN_BASH;
    expect(planTools().map(t => t.name)).not.toContain('bash');
    expect(planPromptFlat()).toContain('CANNOT edit, write, or run commands');
  });

  it('offers read-only bash while bash IS in the tool list', () => {
    process.env.REIKA_PLAN_BASH = '1';
    expect(planTools().map(t => t.name)).toContain('bash');
    const prompt = planPromptFlat();
    expect(prompt).toContain('READ-ONLY shell commands through bash');
    expect(prompt).not.toContain('or run commands');
  });

  it('never offers writing, under either setting', () => {
    for (const flag of [undefined, '1']) {
      if (flag) process.env.REIKA_PLAN_BASH = flag;
      else delete process.env.REIKA_PLAN_BASH;
      expect(planPromptFlat()).toMatch(/CANNOT edit/);
    }
  });
});

// Same coupling as the plan-prompt block above, for the same reason: rule 7 names `ask_user`, and a
// prompt that points a model at a tool it has not been given is worse than saying nothing.
describe('agent prompt tracks the ask_user tool (#214)', () => {
  afterEach(() => {
    delete process.env.REIKA_ASK;
  });

  const agentPrompt = (canAsk?: boolean): string =>
    buildSystemPrompt({ bundle, mode: 'agent', canAsk }).replace(/\s+/g, ' ');

  it('offers ask_user by default, with no flag set', () => {
    delete process.env.REIKA_ASK;
    expect(defaultTools().map(t => t.name)).toContain('ask_user');
    expect(agentPrompt(true)).toContain('ask_user');
  });

  // The baseline arm of any #198 measurement: REIKA_ASK=0 removes the tool AND rule 7 with it, so
  // the comparison runs against a byte-identical prompt rather than a different build.
  it('registers nothing and says nothing when REIKA_ASK=0', () => {
    process.env.REIKA_ASK = '0';
    expect(defaultTools().map(t => t.name)).not.toContain('ask_user');
    expect(planTools().map(t => t.name)).not.toContain('ask_user');
    expect(agentPrompt(false)).not.toContain('ask_user');
  });

  // Subagents run with ask_user filtered out (makeSpawnSubagent) — there is nobody to answer a
  // question raised underneath a tool call the parent is already blocked on.
  it('says nothing about asking when the tool is absent', () => {
    expect(agentPrompt(false)).not.toContain('ask_user');
    expect(agentPrompt(undefined)).not.toContain('ask_user');
  });

  // Phrased as permission, not instruction: it exists to counterweight rule 4 ("do not give up"),
  // which otherwise makes stopping to ask read as quitting.
  it('frames asking as a legitimate outcome rather than an instruction to ask', () => {
    expect(agentPrompt(true)).toContain('Stopping to ask is a legitimate outcome');
  });
});

// The subagent nudge (#273) is the same shape as rule 7: the trigger already rides the tool
// description, the prompt line is permission. Flagged so the baseline arm runs against a
// byte-identical prompt, and keyed off the tool list so a subagent (no recursion) and plan mode
// (no subagent tool) are never pointed at a tool they do not have.
describe('agent prompt subagent nudge (#273)', () => {
  afterEach(() => {
    delete process.env.REIKA_SUBAGENT_NUDGE;
  });

  const agentPrompt = (o: { canAsk?: boolean; canSubagent?: boolean }): string =>
    buildSystemPrompt({ bundle, mode: 'agent', ...o }).replace(/\s+/g, ' ');

  it('is byte-identical to the unflagged prompt when the flag is unset', () => {
    delete process.env.REIKA_SUBAGENT_NUDGE;
    const off = buildSystemPrompt({ bundle, mode: 'agent', canAsk: true });
    expect(buildSystemPrompt({ bundle, mode: 'agent', canAsk: true, canSubagent: true })).toBe(off);
    expect(off).not.toContain('subagent');
  });

  it('adds the line under the flag only when the tool is present', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    expect(agentPrompt({ canAsk: true, canSubagent: true })).toContain('hand it to subagent');
    expect(agentPrompt({ canAsk: true, canSubagent: false })).not.toContain('subagent');
    expect(agentPrompt({ canAsk: true })).not.toContain('subagent');
  });

  // Rule numbering follows rule 7's presence (REIKA_ASK=0 drops it): no gap, no duplicate.
  it('numbers itself after the ask rule, or in its place', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    expect(agentPrompt({ canAsk: true, canSubagent: true })).toContain('8. When answering');
    expect(agentPrompt({ canAsk: false, canSubagent: true })).toContain('7. When answering');
  });

  // Scoped to exploration: the value is N reads collapsing into one digest payload in the parent;
  // a delegated edit is one the parent never read the file for.
  it('frames it around reading and reporting, not delegating edits', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    const p = agentPrompt({ canAsk: true, canSubagent: true });
    expect(p).toContain('what to report back');
    expect(p).not.toMatch(/subagent[^.]*\bedit/);
  });

  it('never appears in the plan prompt', () => {
    process.env.REIKA_SUBAGENT_NUDGE = '1';
    expect(planTools().map(t => t.name)).not.toContain('subagent');
    expect(buildSystemPrompt({ bundle, mode: 'plan', canAsk: true })).not.toContain('subagent');
  });
});

// The plan prompt carries its own ask rule (#272): the plan is a one-shot handoff to an
// implementation turn with no refinement round between (#46 is open), so a wrong reading of the
// request costs the whole implementation turn. Same tool-list coupling as the agent prompt, but
// deliberately NOT the same line — see the comment on rule 5 in prompt.ts.
describe('plan prompt tracks the ask_user tool (#272)', () => {
  afterEach(() => {
    delete process.env.REIKA_ASK;
  });

  const planPromptWith = (canAsk?: boolean): string =>
    buildSystemPrompt({ bundle, mode: 'plan', canAsk }).replace(/\s+/g, ' ');

  it('names ask_user by default, with no flag set', () => {
    delete process.env.REIKA_ASK;
    expect(planTools().map(t => t.name)).toContain('ask_user');
    expect(planPromptWith(true)).toContain('use ask_user ONCE');
  });

  it('says nothing about asking when the tool is absent', () => {
    expect(planPromptWith(false)).not.toContain('ask_user');
    expect(planPromptWith(undefined)).not.toContain('ask_user');
  });

  // Every other plan rule pulls toward converging on a written plan; a bare permission-to-pause
  // (the agent prompt's framing) would pull against that and hand a stalling model a new way not to
  // write. So the plan rule is pinned to the plan on both sides and must stay that way.
  it('routes the ask into the plan rather than granting permission to pause', () => {
    const plan = planPromptWith(true);
    expect(plan).toContain('before writing the plan, then write the plan for the answer');
    expect(plan).toContain('never ask instead of writing the plan');
    expect(plan).not.toContain('Stopping to ask');
  });

  // The ask is for what the code cannot settle — approach, scope, placement — not for what a tool
  // could answer; a low-quant model asks about everything if the trigger is "when unclear".
  it('scopes the ask to what the code cannot settle', () => {
    const plan = planPromptWith(true);
    expect(plan).toContain('the code you have read does not settle it');
    expect(plan).toContain('Never ask what grep/read could tell you');
  });

  // REIKA_ASK=0 is the baseline arm for measuring the rule: tool and rule leave together, so the
  // comparison runs against a prompt that differs by exactly this block.
  it('drops the rule with the tool under REIKA_ASK=0', () => {
    process.env.REIKA_ASK = '0';
    expect(planTools().map(t => t.name)).not.toContain('ask_user');
    expect(planPromptWith(false)).not.toContain('ask_user');
  });
});
