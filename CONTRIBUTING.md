# Contributing

[← README](README.md)

The full conventions — where things live, how to add a tool or slash command, and why each subsystem is shaped the way it is — are in [`AGENTS.md`](AGENTS.md), which Reika also loads as its own instructions when run in this repo. Run `npm run check` before committing.

## Scripts

- `npm run dev` — run the CLI with `tsx`
- `npm run build` — compile TS to `dist/`
- `npm run typecheck` — TypeScript only
- `npm run lint` / `lint:fix`
- `npm run format` / `format:check`
- `npm test` / `test:watch` — vitest unit tests
- `npm run check` — typecheck + lint + format:check + test (use before committing)
- `npm run eval` — run the eval suite against the configured model
- `npm run skills:link` — symlink the skills Reika ships (`.reika/skills/`) into your global skills dir

## Design philosophy

Reika was initially designed around small models, so the source code itself reflects the shape and constraints when using them in a coding agent.

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) so the model sees both in one directory scan
- **One concept per file, shallow directory depth** so a unit fits in a single read
- **Predictable file shapes within a category** (every tool follows the same `Tool` shape) so the pattern is learned once
- **Names that read like sentences** so identifiers reduce the need for explanatory comments
- **Comments only for WHY, never WHAT** — the model already reads what
- **Light on abstraction** — direct code beats three-layer indirection at small-model scales; "rule of three" becomes more like "rule of five"

When the reader is an LLM with a token budget, the case for locality, predictability, and explicit naming gets stronger; the case for clever abstraction gets weaker. See `AGENTS.md` for the longer version.
