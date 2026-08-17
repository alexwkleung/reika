import type { Fixture } from '../types.js';
import { assertRunSeed, CHECK_PROMPT_PREFIX, checkerSetup } from './_checkerlog.js';

// The isolating arm for bash spill (#139) — what 08 is to 06, done by removing the escape rather
// than the shell, because the shell IS the tool under test here.
//
// The failing line carries a seed read from /dev/urandom, so the answer is a property of the
// EXECUTION, not of the tree: it cannot be recomputed from the files, cannot be found by a
// narrower search, and a re-run produces a different value. The only path to the seed the model's
// own run printed is the artifact that run spilled. That makes this the clean measurement of
// locator-following, with bash's usual "just run it again, narrowed" removed.
//
// This is also the case the feature is really justified by, not a contrived one: an expensive,
// flaky, or timestamped run is a one-time artifact, and re-running answers a different question
// than the one asked. The fixture is honest about the cost of that framing — a model that re-runs
// and reports a fresh seed has done something a human might well accept, and the assertion says
// exactly that ("reported seed X, but its run printed Y") rather than calling it nonsense.
//
// Measured 3 runs on kat-coder-qq2, all PASS, all following the locator as the very next call
// after the capped result (3/4/4 calls total). The seed reported was in every case the one its own
// run printed, which is unforgeable evidence the spilled tail crossed into context.
//
// The baseline (REIKA_SPILL=0) is what gives that meaning, and it did NOT fail the way the
// fixture's framing predicted. The model did not fabricate a seed and did not give up: in 2 calls
// it re-ran the checker narrowed and reported a real seed — from the second run. So the escape is
// not actually removed by making the value per-run; it is removed only where RE-RUNNING ITSELF is
// unacceptable (expensive, flaky, or mutating), which a cheap fixture script cannot simulate.
//
// What the pair does establish is a behavior change: with spill the model reads the artifact,
// without it the model executes the command a second time. That is the honest value claim for
// bash spill — it buys back a re-execution — and how much that is worth depends entirely on what
// the command costs to run twice, which is not something this eval can price.
export const fixture: Fixture = {
  name: 'bash-spill-oneshot',
  setup: checkerSetup('seed'),
  prompt:
    CHECK_PROMPT_PREFIX +
    'Tell me which property test failed and the exact seed it printed, so I can reproduce that ' +
    'run. I need the seed from the run you just did.',
  timeoutMs: 10 * 60 * 1000,
  assert: ({ messages }) => assertRunSeed(messages),
};
