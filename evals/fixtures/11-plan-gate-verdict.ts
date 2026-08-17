import type { Fixture } from '../types.js';
import { parsePlanSteps } from '../../src/agent/plantrack.js';
import { planWritten } from '../../src/ui/commands.js';
import { lastAssistantContent } from '../util.js';

// #126 guard rail, aimed at the direction a fix can BREAK rather than at the bug itself.
//
// The bug — a Q2 spiral force-writing a non-plan that vibe then implements — is stochastic by
// nature: convergence on a vague task is roughly a coin flip at this quantization, and the harness
// cannot move that rate (see "Loop breaking & spiral handling"). Its mechanism is pinned
// deterministically in unit tests (`commands.test.ts`, `compaction.test.ts`); an eval cannot pin
// its incidence, and a fixture claiming to reproduce it would be claiming more than it can.
//
// What an eval CAN pin is the opposite failure, which is a live risk of the fix: a gate tightened
// past "has steps" starts rejecting legitimate plans. The prompt below asks for a change to
// behavior that does not exist in the corpus, so a good answer is a GREENFIELD plan — steps naming
// files to be created, none of which exist yet. That is indistinguishable from confabulation by
// reference-checking alone, and it must stay actionable. An earlier draft of this fix, gating on
// whether the plan's references resolve, would have blocked it.
//
// Measured on kat-coder-qq2: the model reports there is no websocket code and proposes creating
// `src/websocket.ts` in 3 steps, all naming paths — the shape this fixture protects.
export const fixture: Fixture = {
  name: 'plan-gate-verdict',
  tools: 'plan',
  mode: 'plan',
  setup: {
    'src/palette.ts': ['// palette module', '', 'export const accent = "#c8a2c8";'].join('\n'),
    'src/easing.ts': [
      '// easing module',
      '',
      'export const easeOut = (t: number) => 1 - t * t;',
    ].join('\n'),
    'README.md': '# demo\n\nA tiny module with a colour and an easing curve.\n',
  },
  prompt:
    'Plan the change needed to make the websocket reconnect backoff configurable per environment.',
  timeoutMs: 10 * 60 * 1000,
  assert: ({ messages }) => {
    const planMsg = [...messages].reverse().find(m => m.role === 'assistant' && !!m.planFinal) as
      | { content?: string }
      | undefined;
    if (!planMsg) {
      // No marker at all (aborted, dead-ended). Both consumers already handle its absence.
      return { pass: true, note: 'plan turn ended with no planFinal marker — nothing to classify' };
    }

    const steps = parsePlanSteps(planMsg.content ?? '');
    // The real gate vibe calls, not a reimplementation — so this fails if the two ever drift apart.
    const gate = planWritten(messages);
    const withPaths = steps.filter(s => s.paths.length > 0).length;
    const anatomy = `${steps.length} step(s), ${withPaths} naming a path`;

    if (gate !== steps.length > 0) {
      return { pass: false, reason: `gate says ${gate} but the plan parses ${anatomy}` };
    }
    if (steps.length === 0) {
      // The #126 shape, arrived at spontaneously. Correct behavior, and worth recording loudly on
      // the rare run that produces it, since it is the case no prompt can be built to force.
      const text = (lastAssistantContent(messages) ?? '').slice(0, 80);
      return {
        pass: true,
        note: `marked plan had NO steps and was correctly rejected — "${text}…"`,
      };
    }
    // The protected case: a plan with steps stays actionable even though every path it names is
    // missing from the tree, because proposing to CREATE a file is what a greenfield plan is.
    return { pass: true, note: `greenfield plan stayed actionable — ${anatomy}` };
  },
};
