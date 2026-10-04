---
# Site-only page: GitHub renders this frontmatter as a table. The repo's landing page is the README.
# `Landing` is the site's own layout (theme/Landing.vue); it reads this frontmatter and the body
# below in this order: hero, body, features, next. `sidebar: false` because this page has no sidebar.
layout: Landing
sidebar: false

hero:
  name: Reika
  text: A coding agent CLI for local and hosted models
  tagline: Designed around small local models first, so it is careful with context, fails more gracefully, and says when it's stuck. It doesn't make a small model smarter. It makes working with one less frustrating.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Findings
      link: /findings
    - theme: alt
      text: Configuration
      link: /configuration

features:
  - title: Context discipline
    details: Old tool output collapses to one-line summaries, and requests stay append-only between shrink events so the engine's prompt cache survives. When the window fills, the model writes its own findings note before older turns fold into a recap.
  - title: Loop and spiral breaking
    details: Repeated reads, re-derived reasoning and runaway thinking blocks are detected from their statistics and answered with an escalating ladder — nudge, pinned ledger, tool withdrawal, honest stop — rather than a 30-minute spiral.
  - title: Checks on what the model does
    details: Blind edits are bounced to a read first, edits are typechecked against a pre-edit baseline, and a written plan is tracked from what the harness observes rather than what the model claims.
  - title: Plan, then implement
    details: A read-only plan mode that ends in a numbered, file-specific plan you can refine over as many turns as you like, and a vibe mode that chains planning and implementation on every prompt.
  - title: Safe and local by default
    details: Approvals stay on for dangerous commands and out-of-project writes, on macOS model-chosen shell commands run under a kernel sandbox, and nothing leaves the model server you configured.
  - title: Measured, not asserted
    details: Every default-on feature leaves a baseline arm behind it, and the record of what broke and what held — with the numbers — is published in the findings.

next:
  - title: Tools
    details: The tools the agent has, which ones register only when their config is present, and how a call reads in the transcript.
    link: /tools
    linkText: Read
  - title: Instructions and skills
    details: The `AGENTS.md` and skills files that steer the agent, and the plain-English routing that picks a skill for a prompt.
    link: /skills
    linkText: Read
  - title: Models
    details: What Reika has been run against in daily use and in evals, local first, with the API models it is compared against.
    link: /models
    linkText: Read
  - title: Platforms
    details: Requirements per platform, and what differs on macOS, Linux and Windows, including running the model on another machine.
    link: /platforms
    linkText: Read
  - title: Architecture
    details: How a turn is put together, what the harness does at each step, and the caveats that come with it.
    link: /architecture
    linkText: Read
  - title: Findings
    details: The measurements behind the claims on this page — what broke, what held, and the numbers for both.
    link: /findings
    linkText: Read
---

![Reika fixing a retry helper and its test with a local model](./demo.gif)

<sup>A real local run of Qwen3.6 35B A3B (Unsloth UD-IQ2_M) via llama.cpp, sped up 3×. The model's first test fails and it fixes it from the error. The measurements behind the features below are in [Findings](findings.md).</sup>

Install it, then point it at a model server:

```sh
pnpm add -g reika                             # or: npm i -g reika
llama-server -m <model.gguf> -c 24576 --jinja # any OpenAI-compatible server will do
cd your-project && reika
```

[Install and first run](getting-started.md) takes it from there, [Usage](usage.md) walks through the
modes and commands, and [Configuration](configuration.md) is the full key list.
