# Agent guide for Reika

This file is loaded automatically by reika when it runs in this directory. Conventions and pointers below.

## Project

reika is a minimal coding-agent CLI. TypeScript strict, ES modules, single-file-per-concern. Built around the assumption that _every token of context counts_ — designed first for small local models, and scales up to cloud.

## Code conventions

- **Formatter**: Prettier — single quotes, semicolons, trailing commas, 100-col width, 2-space indent
- **Linter**: ESLint flat config with typescript-eslint + react-hooks rules
- **Pre-commit**: run `npm run check` (typecheck + lint + format:check)
- **Style**: functions over classes when state is minimal; classes only for things with real lifecycle (e.g. `PayloadStore`)
- **Comments**: only when explaining _why_ (constraints, non-obvious choices). Never explain _what_ — well-named identifiers do that. Never multi-paragraph.
- **Dependencies**: minimal. Adding one needs a clear reason.

## Where things live

| Path            | Purpose                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `src/agent/`    | Turn loop, prompt builder, mention parser                                             |
| `src/provider/` | OpenAI-compatible client + tool-call serialization                                    |
| `src/tools/`    | One tool per file; register in `src/tools/index.ts`                                   |
| `src/context/`  | Bootstrap, repo map, file index (fdir-based)                                          |
| `src/store/`    | Addressable payload storage                                                           |
| `src/ui/`       | Ink components (`.tsx`) + UI helpers (`.ts`) — helpers are UI-coupled, keep them here |
| `evals/`        | Fixture-based agent evals; runner + per-fixture files                                 |
| `src/types.ts`  | Shared types: `Message`, `Tool`, `Config`, `ContextBundle`, etc.                      |

## Adding a new tool

1. Create `src/tools/<name>.ts` exporting a `Tool` (see `read.ts` for read-only shape, `bash.ts` for streaming + approval shape)
2. If it mutates files or runs commands, gate it via `ctx.requestApproval` — never skip the gate
3. Register in `src/tools/index.ts`'s `defaultTools()`
4. Description must be short and action-oriented (small models pay for every token in the system prompt)
5. Add an eval fixture in `evals/fixtures/` if behavior is testable

## Adding a slash command

1. Add to `COMMANDS` in `src/ui/commands.ts` with `name` + `desc`
2. Handle in `App.tsx`'s `handleCommand` switch
3. Update the `/help` text inline in `App.tsx` so users see it

## Adding UI

- Components: `.tsx` in `src/ui/`
- Helpers: `.ts` in `src/ui/` — don't move to a generic `utils/` dir; they're UI-coupled
- Lift state to `App.tsx` for cross-component features (suggestions, approval, mode)
- Bordered boxes use `borderStyle="round"` consistently

## Approval gate

Mutating tools (`edit`, `write`, `bash`) MUST honor `ctx.requestApproval` if present. When it returns `false`, the tool MUST exit without performing its action and emit a clear summary like `"Edit declined by user for X"`. The `ApprovalRequest` object also accepts optional `warnings` — for `bash`, dangerous patterns trigger warnings that bypass session-auto-approve.

## Bundle and prompt caching

`ContextBundle` is built once via `bootstrap()` and treated as stable across turns to maximize prompt caching at the provider. Don't mutate it during a session. The only legitimate refresh path is `/cd`, which re-runs `bootstrap()` for a new cwd. If you add a context source, plumb it into `bootstrap()` and the system-prompt builder; never re-fetch per-turn.

## Eval workflow

`npm run eval` runs all fixtures sequentially against the configured model. Each fixture is self-contained: `setup` files + `prompt` + `assert`. To add one:

1. New file in `evals/fixtures/NN-name.ts` exporting a `Fixture`
2. Import + add to the `FIXTURES` array in `evals/runner.ts`

Eval timeouts use the same `AbortController` pattern as the user-side abort.

## Things to avoid

- Re-fetching project context per-turn (defeats caching, bloats history)
- Adding a mutating tool without an approval check
- Comments that explain _what_ the code does
- Backwards-compat shims and feature flags when you can just change the code
- Multi-paragraph docstrings (keep comments to one short line max)
- Premature abstraction (three similar lines is fine; abstract when the third is genuinely the same shape)

## Cross-provider gotchas worth knowing

- For Qwen3 / DeepSeek-R1 / Kimi K2 on llama.cpp: use `--jinja --reasoning off`, not `--reasoning-budget 0`
- Cloud thinking models (Kimi K2 etc.) require `reasoning_content` to be roundtripped on assistant messages with tool_calls — handled in `src/provider/toolcall.ts`
- gpt-oss family on certain servers leaks `<|channel|>` Harmony markers in tool-call names — `sanitizeToolName()` in `src/provider/client.ts` strips them defensively
