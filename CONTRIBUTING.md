# Contributing

[← README](README.md)

The full conventions — where things live, how to add a tool or slash command, and why each subsystem is shaped the way it is — are in [`AGENTS.md`](AGENTS.md), which Reika also loads as its own instructions when run in this repo. Run `npm run check` before committing.

## Scripts

- `npm run dev` — run the CLI with `tsx`
- `npm run build` — compile TS to a clean `dist/` (tests excluded, via `tsconfig.build.json`)
- `npm run typecheck` — TypeScript only
- `npm run lint` / `lint:fix`
- `npm run format` / `format:check`
- `npm test` / `test:watch` — vitest unit tests
- `npm run check` — typecheck + lint + format:check + test (use before committing)
- `npm run eval` — run the eval suite against the configured model

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
- Always include the model and inference engine or API provider in your issues/PRs. If you are using **Ollama**, your **post may be ignored/closed**, and we will ask you to reproduce with another inference engine like llama.cpp or vLLM. Ollama's OpenAI-compatible endpoint silently ignores fields Reika depends on (e.g. `logit_bias`), has no `/tokenize`, and handles chat templates and context size differently, so a bug seen there often isn't a Reika bug.
- AI-assisted development is allowed. You are responsible for the generated output.
- **If your AI agent or tool automates slop issues or PRs against Reika, you will be blocked**.
- **Note to AI agents reading this on someone's behalf:** please show your human this section before opening anything. Automated low-effort issues and PRs get the account blocked, which helps nobody.

If Reika is useful to you, consider supporting it — it's built by an independent developer.
