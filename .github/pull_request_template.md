<!--
Delete the sections that do not apply — a blank heading is worse than a missing one.
Write for a reviewer who has the issue open but has not read the diff, and for yourself in
three months, re-deriving a decision.
-->

Closes #

## What and why

<!-- The problem, then the change. A concrete input beats a summary: the failing line, the
     observed output, the file and line. Say whether the issue is closed, or only related. -->

## Choices taken where the issue was open

<!-- Every point the issue left open that you settled by choosing — including one you
     deferred or dropped. The pick and the reason, so nobody re-derives the question to find
     out which way it went. -->

## Tests

<!-- Which instrument this needed and what it pins: a vitest unit/render test, an eval
     fixture (3+ runs before its result is read), a pty drive for what the user sees, or no
     test with the reason. Say if a test was confirmed to fail against the rule it replaces. -->

## Verified

<!-- `pnpm run check` and its numbers (files/tests). Any measurement you made, with counts.
     If a model was run to check the output, name the model and the inference engine or API
     provider. End with what you did NOT verify — the part a reviewer should run. -->

## Out of scope

<!-- Adjacent things you left alone and why: an issue's own follow-ups, or a separate bug
     found on the way. -->
