import type { Fixture } from '../types.js';
import { parsePlanSteps } from '../../src/agent/plantrack.js';
import { writtenPlans } from '../util.js';

// Plan refinement (#46). The deterministic halves — that the harness tells a follow-up turn to
// revise, and carries the plan + the newest request through the force-write transform — are pinned
// in unit tests (`loop.planrefine.test.ts`, `plantrack.test.ts`). What no unit test can answer is
// the question the feature actually lives or dies on: does a real model DO it, or does it re-derive
// a plan from the follow-up prompt and drop what the first turn settled? That is an affordance-
// uptake question, so it needs an eval (see "Choosing a test instrument").
//
// The corpus is tiny and the follow-up asks for one concrete addition to the same area, because the
// signal being read is RETENTION: the revised plan has to cover the original change AND the
// follow-up. A model that treats the second prompt as a new task writes a plan for the follow-up
// alone, which the assertion catches. The converse is not pinned — a model that re-derives from
// scratch can still name both files, and the corpus is small enough that it likely will — so a pass
// is evidence the revision framing was followed, and a failure is the real finding.
//
// Unmeasured: this fixture has not been run against a model (see AGENTS.md — an eval change wants 3+
// runs, and one run is an anecdote). Treat the first runs as calibration: if the follow-up reliably
// drags the model into a full re-exploration under the plan ledger's stop-exploring pressure, the
// prompt is the problem, not the feature.
export const fixture: Fixture = {
  name: 'plan-refine',
  tools: 'plan',
  mode: 'plan',
  setup: {
    'src/palette.ts': [
      '// palette module',
      '',
      'export const accent = "#c8a2c8";',
      'export const surface = "#101014";',
    ].join('\n'),
    'src/easing.ts': [
      '// easing module',
      '',
      'export const easeOut = (t: number) => 1 - t * t;',
    ].join('\n'),
    'README.md': '# demo\n\nA tiny module with a colour palette and an easing curve.\n',
  },
  prompt: 'Plan the change needed to make the accent colour configurable per environment.',
  followUp: 'Also make the easing curve configurable the same way.',
  timeoutMs: 15 * 60 * 1000,
  assert: ({ messages, elapsedMs }) => {
    const plans = writtenPlans(messages);
    if (plans.length < 2) {
      return {
        pass: false,
        reason: `expected a plan from each turn, got ${plans.length} plan${plans.length === 1 ? '' : 's'}`,
      };
    }
    const first = plans[plans.length - 2];
    const revised = plans[plans.length - 1];
    if (revised.trim() === first.trim()) {
      return { pass: false, reason: 'the revision re-emitted the first plan unchanged' };
    }
    // Both subjects, by the file each one lives in. The revised plan must still carry the original
    // change — that is the retention the refinement turn exists to buy.
    const named = new Set(
      parsePlanSteps(revised).flatMap(step => step.paths.map(p => p.split('/').pop() ?? p)),
    );
    const lower = revised.toLowerCase();
    const missing = [
      named.has('palette.ts') || lower.includes('palette') ? '' : 'the accent/palette change',
      named.has('easing.ts') || lower.includes('easing') ? '' : 'the easing change',
    ].filter(Boolean);
    if (missing.length > 0) {
      return { pass: false, reason: `revised plan does not cover ${missing.join(' or ')}` };
    }
    return {
      pass: true,
      note: `${parsePlanSteps(revised).length} steps after ${(elapsedMs / 1000).toFixed(0)}s`,
    };
  },
};
