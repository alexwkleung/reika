import { afterEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { buildSystemPrompt } from './prompt.js';
import { planTools } from '../tools/index.js';
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
