import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import { fixture } from './13-plan-refine.js';

// The fixture's assert decides PASS/FAIL for a run this repo cannot execute here (it needs a local
// model) — the same reason `evals/util.test.ts` tests the spill helpers: a wrong assertion is
// indistinguishable from a model behaving differently. So what is pinned here is the READER, not
// the model: given a conversation of a given shape, does the fixture call it a pass?
//
// It cannot pin uptake. Whether a real model revises rather than re-derives is the eval's question,
// and the fixture carries an unrun note saying so.

const PLAN_BOTH =
  '1. Add an env-driven accent to `src/palette.ts`.\n2. Add the same for `src/easing.ts`.';
const PLAN_FIRST_ONLY = '1. Add an env-driven accent to `src/palette.ts`.';

function conversation(secondPlan: string): Message[] {
  return [
    { role: 'user', content: 'make the accent configurable' },
    { role: 'assistant', content: PLAN_FIRST_ONLY, planFinal: true },
    { role: 'user', content: 'also the easing curve' },
    { role: 'assistant', content: secondPlan, planFinal: true },
  ];
}

const assertWith = (messages: Message[]) =>
  fixture.assert({ cwd: '/tmp', messages, elapsedMs: 1000, toolCallCount: 2 });

describe('13-plan-refine assertion', () => {
  it('passes when the revised plan keeps the original change and takes the follow-up', async () => {
    expect(await assertWith(conversation(PLAN_BOTH))).toMatchObject({ pass: true });
  });

  it('fails when the second prompt produced no plan at all', async () => {
    const messages = conversation(PLAN_BOTH).slice(0, 3);
    expect(await assertWith(messages)).toMatchObject({
      pass: false,
      reason: expect.stringContaining('expected a plan from each turn'),
    });
  });

  it('fails when the model re-emitted the first plan unchanged', async () => {
    expect(await assertWith(conversation(PLAN_FIRST_ONLY))).toMatchObject({
      pass: false,
      reason: expect.stringContaining('unchanged'),
    });
  });

  // The failure the fixture exists for: the follow-up was treated as a new task, so the plan that
  // already covered the accent change is gone and only the easing change remains.
  it('fails when the revised plan dropped the original change', async () => {
    const dropped = '1. Add an env-driven easing to `src/easing.ts`.';
    expect(await assertWith(conversation(dropped))).toMatchObject({
      pass: false,
      reason: expect.stringContaining('accent/palette'),
    });
  });
});
