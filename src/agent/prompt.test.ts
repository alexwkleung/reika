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

  it('offers ask_user when the tool is in the list', () => {
    process.env.REIKA_ASK = '1';
    expect(defaultTools().map(t => t.name)).toContain('ask_user');
    expect(agentPrompt(true)).toContain('ask_user');
  });

  // The baseline arm of any #198 measurement: flag off means the tool is gone AND rule 7 goes with
  // it, so the comparison runs against a byte-identical prompt rather than a different build.
  it('registers nothing and says nothing when the flag is off', () => {
    delete process.env.REIKA_ASK;
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

  // Deliberate: plan mode's every rule pulls toward converging on a written plan, and a
  // permission-to-pause line pulls against it — a stalling model would get a new way not to write.
  // Plan mode resolves ambiguity by iterating on the plan across turns (#46) instead. The tool is
  // still in planTools for a model that hits a real contradiction; the prompt just doesn't push it.
  it('leaves the plan prompt alone', () => {
    process.env.REIKA_ASK = '1';
    expect(planTools().map(t => t.name)).toContain('ask_user');
    const plan = buildSystemPrompt({ bundle, mode: 'plan', canAsk: true });
    expect(plan).not.toContain('ask_user');
    expect(plan).not.toContain('Stopping to ask');
  });
});
