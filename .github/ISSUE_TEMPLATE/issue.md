---
name: Issue
about: A bug, a change you want, or something to do later
labels: [triage]
---

<!--
Prefix the title with the area it touches — `[UI]`, `[Bash]`, `[Config]`, `[Chore]` — the way
the rest of the issues here are named.

Delete the sections that do not apply — a blank heading is worse than a missing one, and a
three-line issue is fine when that is all there is to say. Write for whoever picks this up
later — they have the repository and this issue, not your session — and for yourself in three
months, re-deriving the finding.
-->

## What happens today

<!-- The problem, then a concrete input: the command or prompt, the harness that drove it —
     reika's own session, unless a script or another harness drives reika itself — the model
     and the inference engine or API provider, the observed output, the file and line. A rate
     measured over saved sessions ("4 of 96 used the idiom, 1 failed") beats "sometimes". -->

## What should change

<!-- What you want instead, and why that over the alternatives. If a model has to run to test
     it, name it here. -->

## Options and open questions

<!-- Anything you left undecided, including a point you deliberately defer — so whoever picks
     this up settles it rather than re-deriving the question. "Good to have, no plan yet" is a
     legitimate answer here. -->

## Tests

<!-- What would prove it works and pin it against regression: the command that fails today, the
     fixture, the pty drive for what the user sees, or that it needs a model run. Say so if it
     needs no test. -->

## Considered and rejected

<!-- Approaches already ruled out and why, so they are not re-proposed. -->
