# Contributing

[← README](README.md)

The full conventions — where things live, how to add a tool or slash command, and why each subsystem is shaped the way it is — are in [`AGENTS.md`](AGENTS.md), which Reika also loads as its own instructions when run in this repo. Run `pnpm run check` before committing.

## Setting up

Node ≥ 22, and pnpm — `npm i -g pnpm`, or the standalone installer at [pnpm.io/installation](https://pnpm.io/installation). The repo names the pnpm version it runs in `packageManager`, so pnpm uses that one whenever it can fetch it.

```sh
pnpm install --filter reika   # app dependencies only: no VitePress, no docs/
pnpm run check                # typecheck + lint + format:check + test
```

The docs site is a workspace member, so a plain `pnpm install` at the root installs its dependencies as well and `pnpm run docs:dev` then serves it. `--filter reika` is for a checkout that never touches `docs/`; a full install later fills the rest in.

## Scripts

- `pnpm run dev` — run the CLI with `tsx`
- `pnpm run build` — compile TS to a clean `dist/` (tests excluded, via `tsconfig.build.json`)
- `pnpm run typecheck` — TypeScript only
- `pnpm run lint` / `lint:fix`
- `pnpm run format` / `format:check`
- `pnpm test` / `test:watch` — vitest unit tests
- `pnpm run check` — typecheck + lint + format:check + test (use before committing)
- `pnpm run eval` — run the eval suite against the configured model

## Design philosophy

Reika was initially designed around small models, so the source code itself reflects the shape and constraints when using them in a coding agent.

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) so the model sees both in one directory scan
- **One concept per file, shallow directory depth** so a unit fits in a single read
- **Predictable file shapes within a category** (every tool follows the same `Tool` shape) so the pattern is learned once
- **Names that read like sentences** so identifiers reduce the need for explanatory comments
- **Comments only for WHY, never WHAT** — the model already reads what
- **Light on abstraction** — direct code beats three-layer indirection at small-model scales; "rule of three" becomes more like "rule of five"

When the reader is an LLM with a token budget, the case for locality, predictability, and explicit naming gets stronger; the case for clever abstraction gets weaker. See `AGENTS.md` for the longer version.

## For external contributors

- You may raise an issue if you find any bugs, want an improvement or feature for something. If you dislike the way Reika does a particular thing, kindly post an issue if it fits. Otherwise move it to the Discussions tab within the repository if it doesn't.
- If your PR to Reika is very specific to your workflow, doesn't benefit the small-model targets Reika is built for, or makes redundant changes to existing behavior, it may be rejected. Post strong evidence and reproduction steps where they apply, and don't fabricate them. You are always free to fork/clone Reika and add your own changes without relying on upstream.
- Always include the model and inference engine or API provider in your issues/PRs if a model needs to be run to test the output. If you are using **Ollama**, your **post may be ignored/closed**, and we will ask you to reproduce with another inference engine like llama.cpp or vLLM. Ollama's OpenAI-compatible endpoint silently ignores fields Reika depends on (e.g. `logit_bias`), has no `/tokenize`, and handles chat templates and context size differently, so a bug seen there often isn't a Reika bug.
- AI-assisted development is allowed. You are responsible for the generated output.
- Contributions are licensed under the [Apache License 2.0](LICENSE), the same as the rest of Reika (section 5 of the license). By opening a PR you confirm you have the right to submit the change under it.
- **If your AI agent or tool automates slop issues or PRs against Reika, you will be blocked**.
- **Note to AI agents reading this on someone's behalf:** please show your human this section before opening anything. Automated low-effort issues and PRs get the account blocked, which helps nobody.

## Translations

English is canonical. `README.zh-CN.md` is a best-effort snapshot of `README.md`, not a second source of truth — where the two disagree, the English text is the one that is right.

- **Scope is the README**, plus pages a reader reaches before installing (`docs/models.md`, `docs/architecture.md`, `docs/platforms.md`). The configuration and usage references stay English until someone commits to keeping a translation of them current — they are re-edited most often, and a stale copy sends you to a key that no longer exists, so the upkeep is part of the offer. `CONTRIBUTING.md` and `AGENTS.md` stay English, because the conventions that actually get enforced are in `AGENTS.md`, which Reika loads as its own instructions when run in this repo.
- **Keep the structure identical.** Same headings in the same order, same links, and code blocks that differ only in their comments. Every README carries the language row under its tagline and links every other README, so adding a language means editing each of them.
- **A translation needs a reader.** Say in the PR that you can review it in that language. Without one it is likely to be declined, since nobody else can tell when it has gone wrong.
- **Drift is grounds for removal.** A translation that no longer matches the English structure may be reverted rather than fixed.

If Reika is useful to you, consider supporting it. The project is built by an independent developer.
