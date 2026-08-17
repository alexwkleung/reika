import type { Fixture } from '../types.js';
import { assertSpillFollowed, FLAG_PROMPT, flagModuleSetup } from './_flagmodules.js';

// The same corpus and prompt as 06, with `planTools()` instead of the full set — read/list/grep/
// glob, no bash. This is the A/B arm: 06 shows the model routing around the spill locator through
// a pipe, and the corpus is shared byte-for-byte so the tool set is the only difference.
//
// Not an artificial constraint. It is what plan mode ships, and plan mode is where reika's
// exploration loops live — so if a spill locator pays off anywhere, it is here. Note the escape
// is only *narrowed*, not closed: without pipes the model can still re-grep per file, so the real
// question is whether paging one saved result beats ten narrower searches.
//
// Scoped deliberately to the tool set rather than `promptMode: 'plan'`. Running full plan mode
// would drag in the force-write machinery, the novelty cap and a written-plan deliverable, and
// the outcome could no longer be attributed to bash availability.
export const fixture: Fixture = {
  name: 'grep-spill-noshell',
  setup: flagModuleSetup(),
  prompt: FLAG_PROMPT,
  tools: 'plan',
  timeoutMs: 12 * 60 * 1000,
  assert: ({ messages }) => assertSpillFollowed(messages),
};
