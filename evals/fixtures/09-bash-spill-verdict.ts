import type { Fixture } from '../types.js';
import { assertCheckerVerdict, CHECK_PROMPT_PREFIX, checkerSetup } from './_checkerlog.js';

// The REIKA_SPILL question for `bash` (#139), in the shape the feature is actually for: a long run
// whose verdict is at the END, which is precisely the end the old head-truncation discarded. Before
// the tail spill, this prompt was UNANSWERABLE from the run's own output — the model saw 64KB of
// "ok" and the verdict had never been read off the pipe at all.
//
// This is the reformulable arm, the bash analogue of 06. The checker computes its verdict at run
// time, so `cat ci/check.sh` cannot answer it — but `wc -l src/*.ts` can, and re-running the
// checker through `| tail` can, and both are cheap here in a way they are not on a real 90-second
// test suite. That gap between fixture and reality is the thing to hold in mind when reading a
// route-around: it is a correct move for THIS corpus and often the wrong one in the case the
// feature exists for. 10 removes the escape rather than pretending it isn't there.
//
// A route-around that still answers correctly is reported as such rather than as a bare failure —
// "did not follow the locator, answer was still correct" and "did not follow the locator, answer
// was wrong too" are different findings and the second is the one that would matter.
//
// Measured 3 runs on kat-coder-qq2: PASS (5 calls) / FAIL / PASS (4 calls, followed immediately).
// The failure is the interesting one and it is NOT a route-around — the model reached for the
// artifact with `tail -50 <path>` and MISTYPED the path, dropping a character out of the ~100-char
// temp locator, then never named it correctly again. It answered correctly anyway by other means.
// So the locator itself is a transcription hazard at this quantization, which is a property of
// `_spill.ts` rather than of bash and applies to the grep/glob fixtures equally.
//
// With REIKA_SPILL off this fixture still answers correctly (via `wc -l`), which is the honest
// limit of this arm: it demonstrates the mechanism works, not that it was needed. 10 is the arm
// that establishes need.
export const fixture: Fixture = {
  name: 'bash-spill-verdict',
  setup: checkerSetup('verdict'),
  prompt:
    CHECK_PROMPT_PREFIX +
    'Tell me which file it flagged and how many lines that file has. Be exact — I need the number ' +
    'it reported.',
  // ~200KB of output means a 64KB payload lands in a 24k-token window; the model may compact
  // before it can act on the footer, and that recovery takes turns.
  timeoutMs: 10 * 60 * 1000,
  assert: ({ messages }) => assertCheckerVerdict(messages),
};
