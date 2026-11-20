---
# Site-only page: GitHub renders this frontmatter as a table. The repo's landing page is the README.
# `Landing` is the site's own layout (theme/Landing.vue); it reads this frontmatter and the body
# below in this order: hero (with `install`), body, features, docs. `sidebar: false` because this page has no sidebar.
layout: Landing
sidebar: false
# Opt out of the site `titleTemplate` in config.ts, so the landing keeps the full
# site title as its tab title instead of "… | Reika".
titleTemplate: false

hero:
  name: Reika
  text: A coding agent CLI for local and hosted models
  tagline: Designed around small local models first, so it is careful with context, fails more gracefully, and says when it's stuck. It doesn't make a small model smarter. It makes working with one less frustrating.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/alexwkleung/reika
    - theme: alt
      text: Read the findings
      link: /findings
    - theme: alt
      text: Blog
      link: /blog/

install:
  - label: npm
    command: npm i -g @alexwkleung/reika
  - label: pnpm
    command: pnpm add -g @alexwkleung/reika
  - label: brew
    command: brew install alexwkleung/tap/reika

featuresTitle: What it does
features:
  - title: Context discipline
    details: Old tool output collapses to short summaries and requests stay append-only, so a slow local engine's prompt cache survives.
  - title: Loop breaking
    details: Repeated reads and runaway reasoning are detected and stopped, ending in an honest stop instead of a long spiral.
  - title: Checks on the model's work
    details: Blind edits go back for a read first, TypeScript edits are typechecked, and plan progress is tracked from what actually happened.
  - title: A mode for the job
    details: Plan before anything changes, put a harder change through a test-and-review procedure, keep a small window lean, or just chat. Shift+Tab switches.
  - title: Safe by default
    details: Dangerous commands still prompt, and on macOS shell commands run in a kernel sandbox. No telemetry.
  - title: Measured
    details: Default-on features keep an off switch for A/B runs, and what they did and didn't fix is published.

docsTitle: Documentation
docs:
  - title: Install
    details: Requirements and first run
    link: /getting-started
  - title: Usage
    details: Modes, commands and keys
    link: /usage
  - title: Configuration
    details: Every setting
    link: /configuration
  - title: Tools
    details: What the agent can call
    link: /tools
  - title: Instructions and skills
    details: AGENTS.md and slash commands
    link: /skills
  - title: Models
    details: What it has been run against
    link: /models
  - title: Platforms
    details: macOS, Linux and Windows
    link: /platforms
  - title: Architecture
    details: How a turn is put together
    link: /architecture
  - title: Findings
    details: What broke and what held
    link: /findings
  - title: Support
    details: Funding and other ways to help
    link: /support
---

<DemoToggle
  terminal-alt="Reika fixing a retry helper and its test with a local model"
  terminal-caption="A real local run of Qwen3.6 35B A3B (Unsloth UD-IQ2_M) via llama.cpp, sped up 3×. The model fixes its own indentation, adds a test for the delays, and the tests pass on the first run."
  web-alt="The same task in reika web: Reika fixing a retry helper and its test with a local model"
  web-caption="A real local run of Qwen3.6 35B A3B (Unsloth UD-IQ2_M) via llama.cpp, sped up 3×. The model makes the change, writes five tests for the delays, and they pass on the first run."
/>
