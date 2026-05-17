# Agent Guide for Reika

This file is loaded automatically by Reika when it runs in this directory. Conventions and pointers below.

## Project

Reika is a minimal coding-agent CLI. TypeScript strict, ES modules, single-file-per-concern. Built around the assumption that _every token of context counts_ — designed first for small local models, and scales up to cloud.

## Design rationale: agent-first ergonomics

Reika is meant to be edited by small local models, frequently dogfooding itself. That constraint shapes a number of choices that would otherwise be pure style preferences. The pattern: optimize for "how cheaply can an LLM with limited context understand and modify a unit in isolation."

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) — when the model edits `bar.ts`, the test file appears in the same directory listing. With a separate `tests/` tree, models often miss the tests entirely and break them silently.
- **One concept per file, shallow directory depth (≤3–4 levels)** — a 5000-line file forces partial reads and lost context. Deep nesting adds path-traversal cost to every lookup.
- **Predictable file shapes within a category** — every tool file (`src/tools/*.ts`) exports a single `Tool` object with the same structure. The model learns the pattern once and applies it elsewhere without re-exploring.
- **Names that read like sentences** — `findFreshToolBlockStart` is faster for the model to understand than `getStart` plus a 5-line comment explaining what "start" means.
- **Comments for WHY only** — the model can read the code. Only motivation, constraint, or non-obvious-tradeoff information is new signal.
- **Skip heavy indirection** — Factory → AbstractBuilder → ConcreteImpl chains cost tokens at every layer the model traverses to find one fact. Direct code that does one thing beats reusable generics at small-model scale. The "rule of three" for extracting abstractions shifts toward "rule of five" — accept mild duplication before abstracting.
- **Front-load discovery into the bootstrap context** — AGENTS.md, repo map, file index, project summary all flow into the system prompt at startup so the model doesn't burn turns rediscovering structure each session.

Most of these are also just good hygiene for humans. What's different is the cost-benefit math: when the reader is an LLM with a token budget, **locality wins over modularity**, **explicit naming wins over clever naming + docs**, **direct code wins over abstraction**. When you're tempted to add a layer for cleanliness, ask: does this make the code 2× easier for a model to edit, or 0.5× easier? Often the answer is the latter.

## Code conventions

- **Formatter**: Prettier — single quotes, semicolons, trailing commas, 100-col width, 2-space indent
- **Linter**: ESLint flat config with typescript-eslint + react-hooks + unused-imports rules. Unused imports are auto-removed by `npm run lint:fix` — leave that cleanup to the tool rather than manual pruning.
- **Tests**: vitest, colocated `*.test.ts` files (e.g. `client.test.ts` next to `client.ts`)
- **Pre-commit**: run `npm run check` (typecheck + lint + format:check + test)
- **Style**: functions over classes when state is minimal; classes only for things with real lifecycle (e.g. `PayloadStore`)
- **Comments**: only when explaining _why_ (constraints, non-obvious choices). Never explain _what_ — well-named identifiers do that. Never multi-paragraph.
- **Dependencies**: minimal. Adding one needs a clear reason.

## Where things live

| Path            | Purpose                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `src/agent/`    | Turn loop, prompt builder, mention parser                                             |
| `src/provider/` | OpenAI-compatible client + tool-call serialization                                    |
| `src/tools/`    | One tool per file; register in `src/tools/index.ts`                                   |
| `src/context/`  | Bootstrap, repo map, file index (fdir-based), gitignore                               |
| `src/search/`   | Web search providers — `types.ts` (interface) + per-provider adapters                 |
| `src/store/`    | Addressable payload storage                                                           |
| `src/ui/`       | Ink components (`.tsx`) + UI helpers (`.ts`) — helpers are UI-coupled, keep them here |
| `evals/`        | Fixture-based agent evals; runner + per-fixture files                                 |
| `src/types.ts`  | Shared types: `Message`, `Tool`, `Config`, `ContextBundle`, etc.                      |

## Adding a new tool

1. Create `src/tools/<name>.ts` exporting a `Tool` (see `read.ts` for read-only shape, `bash.ts` for streaming + approval shape)
2. If it mutates files or runs commands, gate it via `ctx.requestApproval` — never skip the gate
3. Register in `src/tools/index.ts`'s `defaultTools(config)`. If the tool needs a credential or endpoint, branch on the config (env-var-gated registration — keeps the system prompt lean for users who haven't opted in)
4. Description must be short and action-oriented (small models pay for every token in the system prompt)
5. Add an eval fixture in `evals/fixtures/` if behavior is testable

## Optional tools and provider abstractions

When a tool wraps an external service (web search, GitHub, etc.):

- Put the provider abstraction in its own subdir (e.g. `src/search/types.ts` with `SearchProvider` interface; per-provider adapters next to it)
- The tool file (`src/tools/search.ts`) is a thin factory that takes a provider and returns a `Tool`
- Register conditionally in `defaultTools(config)` based on which credentials are present
- Multiple providers for the same role (Tavily, SearXNG, Brave, Exa…) implement the same interface; switching is config-only, no tool-layer changes

This is how `search` + `fetch_url` are wired. Two providers implement `SearchProvider`: `SearxngProvider` (self-hosted, local-first) and `TavilyProvider` (cloud, AI-optimized snippets). SearXNG takes precedence when both `REIKA_SEARXNG_URL` and `REIKA_TAVILY_API_KEY` are set. If neither is set, neither tool registers and the system prompt stays lean.

## Adding a slash command

1. Add to `COMMANDS` in `src/ui/commands.ts` with `name` + `desc`
2. Handle in `App.tsx`'s `handleCommand` switch
3. Update the `/help` text inline in `App.tsx` so users see it

## Adding UI

- Components: `.tsx` in `src/ui/`
- Helpers: `.ts` in `src/ui/` — don't move to a generic `utils/` dir; they're UI-coupled
- Lift state to `App.tsx` for cross-component features (suggestions, approval, mode)
- Bordered boxes use `borderStyle="round"` consistently

## Theme

Semantic colors live in `src/ui/theme.ts`. Components reference them via `theme.accent`, `theme.warning`, etc. — never hardcoded color strings. The pattern:

- `accent` (magentaBright) — brand + focus (Reika title, user `▎`, selected `›`, spinner)
- `tool` (cyan) — tool activity (tool call `·` + name, tool result `↳`)
- `secondary` (gray) — muted UI text
- `warning` (yellow) — wait/caution (approval box border)
- `error` (red) — problem (error box border, diff `-` lines, WARNING heading)
- `success` (green) — positive (diff `+` lines, shell `$` prompt)

To re-theme, edit `theme.ts` only. New UI must consult these names, not introduce hardcoded colors.

## Layout

`App.tsx` sets `paddingX={1}` on its outer Box for a uniform 1-column gutter. Don't add competing horizontal padding to top-level children — bordered boxes and inline content stay visually aligned because they all live inside that single gutter.

## Modes (agent / shell / chat)

Three runtime modes. Each affects what input does and what context is preserved.

| Mode              | Input behavior                                                                | Tools                                                        | History                                                                   |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `agent` (default) | Runs through model + agent system prompt                                      | `defaultTools(config)` — full set                            | shared with shell                                                         |
| `shell`           | Runs as bash directly (no model)                                              | n/a                                                          | shared with agent — shell output becomes part of agent's context          |
| `chat`            | Runs through model + lean chat system prompt (no tool-use rules, no repo map) | `chatTools(config)` — knowledge-only (`search`, `fetch_url`) | **isolated** — separate `messages` array, stashed/restored on mode switch |

Implementation: a single `messages` state holds the active mode's history. When the user crosses the chat boundary (agent/shell ↔ chat), `stashedMessagesRef` saves the outgoing side and restores the incoming side's prior history. Switching between agent and shell does not stash because they share. `/new` clears only the current mode's history (the other side's stash survives).

Mode switches are blocked while `status === 'busy'` to avoid mid-turn state corruption.

When adding new modes, follow the same pattern: decide which existing side it shares with (or define its own stash slot) and update the swap logic in `switchMode()`.

## Approval gate

Mutating tools (`edit`, `write`, `bash`) MUST honor `ctx.requestApproval` if present. When it returns `false`, the tool MUST exit without performing its action and emit a clear summary like `"Edit declined by user for X"`. The `ApprovalRequest` object also accepts optional `warnings` — for `bash`, dangerous patterns trigger warnings that bypass session-auto-approve.

**Session vs env auto-approve:** `REIKA_AUTO_APPROVE=true` skips the gate entirely (App passes `requestApproval: undefined` to `runTurn`). The session-level toggle (`/approvals on`, or the "Always (this session)" choice during a prompt) flips `sessionAutoApprove` state, which short-circuits inside `requestApproval`. Env always wins; the slash command is no-op when env is on. Status bar shows a yellow `auto-approve` indicator when either is active.

## Bundle and prompt caching

`ContextBundle` is built once via `bootstrap()` and treated as stable across turns to maximize prompt caching at the provider. Don't mutate it during a session. The only legitimate refresh path is `/cd`, which re-runs `bootstrap()` for a new cwd. If you add a context source, plumb it into `bootstrap()` and the system-prompt builder; never re-fetch per-turn.

## .gitignore is honored

Bootstrap loads `.gitignore` (and `.git/info/exclude`) into an `Ignore` instance on `bundle.ignore`. Any walker that touches the filesystem MUST consult it: `buildFileIndex` (fdir exclude+filter), `buildRepoMap` (manual walk), `list` and `grep` tools (via `ctx.ignore`). New walkers added to tools or context modules MUST do the same — otherwise the agent burns exploration on build outputs.

## Config sources

`loadConfig()` reads dotenv from cwd `.env` first, then `~/.config/reika/.env` as fallback. Shell env vars take precedence over both (dotenv's no-override default). Order matters — don't reorder without thinking about precedence.

## Profiles

`Config.profiles` is a map of named `Profile` objects (`model` + `baseURL` + `apiKey`). The "default" profile is always present, derived from the flat `REIKA_MODEL`/`BASE_URL`/`API_KEY` keys. Additional profiles come from `REIKA_PROFILES=kimi,gpt4` + per-profile `REIKA_<NAME>_MODEL` etc.

When calling `runTurn`, App.tsx passes `resolveProfile(config, activeProfile)` rather than raw config — that overlays the active profile's `model`/`baseURL`/`apiKey` onto the rest. `/model <name>` updates `activeProfile`. Profile names are lowercased on load; matching is case-insensitive.

Subagent overrides (`REIKA_SUBAGENT_*`) are independent of profiles — they always come from the top-level config regardless of which profile is active. This is intentional: subagent model selection is a separate axis from main-thread model selection.

## Tests (vitest)

`npm test` runs all unit tests (sub-second). Covered modules with bug-prone pure logic:

- `src/provider/toolcall.ts` — `messagesToOpenAI` (assistant content nulling, tool message `name` field, payload aging)
- `src/provider/client.ts` — `sanitizeToolName`, `extractToolCallsFromContent`
- `src/ui/suggest.ts` — command + file autocomplete matching
- `src/ui/summary.ts` — session stats derivation
- `src/agent/mentions.ts` — `@filepath` expansion
- `src/search/tavily.ts`, `searxng.ts` — provider request shape + response normalization (fetch mocked)

**Not covered (deliberately):** UI components (Ink testing is awkward; evals own end-to-end behavior), tools that wrap node fs/process (read/list/grep/edit/write/bash — shallow wrappers), the agent loop itself (evals territory).

**When editing a covered module, run `npm test` before declaring done.** Tests catch regressions evals can't (evals only run when a real model invokes the broken path).

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
