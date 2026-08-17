import type { Fixture } from '../types.js';
import { assertSpillFollowed, FLAG_PROMPT, flagModuleSetup } from './_flagmodules.js';

// The REIKA_SPILL follow-through question (tools/_spill.ts) with the full tool set, where the
// model has a pipe.
//
// This fixture is EXPECTED TO FAIL on most models, and is kept for what that failure records
// rather than tuned until it passes. Measured over three runs on kat-coder-qq2: one run followed
// the locator (665s, 16 calls), two routed around it — `bash grep -r FLAG_ | sed | sort -u` in
// 98 bytes, and a narrower re-grep. Both were the better move. The question asks WHICH FILES, so
// any query that projects 150 matches down to 6 filenames beats paging a saved result, and the
// run that did follow the locator took ~3.5x as long as the ones that didn't.
//
// The generalization, and the reason the prompt is not rewritten to force a pass: grep is
// inherently reformulable in a way glob is not. Grep takes a pattern, so a model can always
// narrow it or pipe the output; glob's "last path alphabetically" (07) has no narrower pattern
// that produces it, which is why that fixture passes 3/3 and this one does not. Rewriting the
// question here would paper over a property of the tool. 08 removes the shell instead, which
// isolates the variable rather than hiding it.
export const fixture: Fixture = {
  name: 'grep-spill-aggregable',
  setup: flagModuleSetup(),
  prompt: FLAG_PROMPT,
  // A capped grep plus a paged read of the saved result runs long on a quantized local model; the
  // 5-minute default cut the first observed run off mid-recovery and reported a timeout instead
  // of an outcome.
  timeoutMs: 12 * 60 * 1000,
  assert: ({ messages }) => assertSpillFollowed(messages),
};
