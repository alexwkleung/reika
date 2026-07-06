# Agent Guide for Reika

This file is loaded automatically by Reika when it runs in this directory. Conventions and pointers below.

## Project

Reika is a coding-agent CLI for small local models. TypeScript strict, ES modules, single-file-per-concern. Built around the assumption that _every token of context counts_ — designed first for small local models, and scales up to cloud. Tuned for low quantization, with a focus on context discipline and capability alignment.

## Design rationale: agent-first ergonomics

### Reika source code specific

Reika initially was intended to be edited by small local models and dogfooding itself. However, while this isn't always the case, the constraint still holds strong and shapes the number of choices that would otherwise be pure style preferences. The pattern: optimize for "how cheaply can an LLM with limited context understand and modify a unit in isolation.".

Some conventions and source code will look noisy when manually auditing. That is expected because of our applied constraints, preferences, and intentions for Reika. So it may break out of traditional patterns in favor of optimizing for our problem/goals without going overboard.

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) — when the model edits `bar.ts`, the test file appears in the same directory listing. With a separate `tests/` tree, models often miss the tests entirely and break them silently.
- **One concept per file, shallow directory depth (≤3–4 levels)** — a 5000-line file forces partial reads and lost context. Deep nesting adds path-traversal cost to every lookup.
- **Predictable file shapes within a category** — every tool file (`src/tools/*.ts`) exports a single `Tool` object with the same structure. The model learns the pattern once and applies it elsewhere without re-exploring.
- **Names that read like sentences** — `findFreshToolBlockStart` is faster for the model to understand than `getStart` plus a 5-line comment explaining what "start" means.
- **Comments for WHY only** — the model can read the code. Only motivation, constraint, or non-obvious-tradeoff information is new signal.
- **Skip heavy indirection** — Factory → AbstractBuilder → ConcreteImpl chains cost tokens at every layer the model traverses to find one fact. Direct code that does one thing beats reusable generics at small-model scale. The "rule of three" for extracting abstractions shifts toward "rule of five" — accept mild duplication before abstracting.

### General/agent

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

| Path            | Purpose                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `src/agent/`    | Turn loop, prompt builder, mention parser, history compaction (`compaction.ts`)             |
| `src/provider/` | OpenAI-compatible client, tool-call serialization, token estimate/calibration (`tokens.ts`) |
| `src/tools/`    | One tool per file; register in `src/tools/index.ts`                                         |
| `src/context/`  | Bootstrap, repo map, file index (fdir-based), gitignore                                     |
| `src/search/`   | Web search providers — `types.ts` (interface) + per-provider adapters                       |
| `src/store/`    | Addressable payload storage                                                                 |
| `src/ui/`       | Ink components (`.tsx`) + UI helpers (`.ts`) — helpers are UI-coupled, keep them here       |
| `evals/`        | Fixture-based agent evals; runner + per-fixture files                                       |
| `src/types.ts`  | Shared types: `Message`, `Tool`, `Config`, `ContextBundle`, etc.                            |

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
- Multiple providers for the same role (SearXNG, Brave, Exa…) could implement the same interface; switching is config-only, no tool-layer changes

This is how `search` + `fetch_url` are wired. `SearxngProvider` (self-hosted, local-first) implements `SearchProvider`. Reika deliberately ships only the local-first provider — no third-party tool-use APIs — but the interface stays vendor-neutral so another provider can be slotted into `makeSearchProvider` later. If `REIKA_SEARXNG_URL` is unset, neither tool registers and the system prompt stays lean.

**Per-turn budget for web tools:** `runTurn` creates a `webBudget` object once per user turn and passes it through `ToolContext`. `search` and `fetch_url` increment their respective counter before running; if at max, return a budget-exceeded summary without actually calling the upstream. This prevents runaway model loops from hammering SearXNG (which proxies to Google/Bing — they rate-limit per IP, so a runaway agent can get your queries blocked at the upstream level). Caps are configurable via `REIKA_MAX_SEARCHES_PER_TURN` and `REIKA_MAX_FETCHES_PER_TURN`. Subagents get their own fresh budget (independent `runTurn` invocation).

## Adding a slash command

1. Add to `COMMANDS` in `src/ui/commands.ts` with `name` + `desc`
2. Handle in `App.tsx`'s `handleCommand` switch
3. Update the `/help` text inline in `App.tsx` so users see it

A command that both **switches mode and submits to the model in one tick** (e.g. `/implement`, which flips to agent mode and runs "execute the plan above") must pass an explicit mode to `submitToModel`'s `modeOverride` param — the `setMode` call hasn't flushed yet, so `submitToModel`'s `mode` closure would still read the old mode and pick the wrong tools/`promptMode`.

## Adding UI

- Components: `.tsx` in `src/ui/`
- Helpers: `.ts` in `src/ui/` — don't move to a generic `utils/` dir; they're UI-coupled
- Lift state to `App.tsx` for cross-component features (suggestions, approval, mode)
- Bordered boxes use `borderStyle="round"` consistently

### Persistent vs ephemeral signals

Match the signal's lifetime to whether the user **must** see it. A signal the user has to notice — a harness action with a side effect (a URL fetched on the model's behalf), an outcome that changes what they should trust (the typecheck gate sending the model back, an unreachable link) — belongs in a **persistent scrollback line**, emitted as a `system` message via `onMessage` (`tone: 'info' | 'warn'`, `nested: true` to sit it under the action that caused it). It survives in history, so a glance up the transcript reconstructs what happened — a spinner state that's already gone can't. The split both the typecheck gate and URL grounding use: the model-facing detail goes into history/tool payload, the user-facing receipt goes out as a `system` notice.

Reserve **ephemeral** UI (spinner text, a transient pulse like the typecheck "checking…" indicator) for _in-progress_ status that's meaningless once the action finishes — never for the result. If a user could reasonably ask "did that even run?" after the fact, it wasn't persistent enough.

### Ink wrapping pitfalls

Two interactions to watch for when content can wrap:

1. **`flexDirection="row"` + a wrappable Text mis-renders continuation lines** (blank lines appear between wrap breaks). Fix: drop the row layout and use a single Text with nested color segments for inline markers.
2. **Color on a nested Text doesn't survive wrapping** — the outer Text's color (or default) wins on continuation lines. Fix: put the dominant color on the OUTER Text and let inner segments override (e.g., for accent markers).

Combined pattern for "marker + body that may wrap":

```tsx
<Text color={theme.muted}>
  <Text color={theme.accent}>{'❯ '}</Text>
  {content}
</Text>
```

Don't use `<Box flexDirection="row">` to compose marker + body unless you're certain the body won't wrap.

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

## Modes (agent / shell / chat / plan)

Four runtime modes. Each affects what input does and what context is preserved.

| Mode              | Input behavior                                                                | Tools                                                        | History                                                                                        |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `agent` (default) | Runs through model + agent system prompt                                      | `defaultTools(config)` — full set                            | shared with shell + plan                                                                       |
| `shell`           | Runs as bash directly (no model)                                              | n/a                                                          | shared with agent — shell output becomes part of agent's context                               |
| `chat`            | Runs through model + lean chat system prompt (no tool-use rules, no repo map) | `chatTools(config)` — knowledge-only (`search`, `fetch_url`) | **isolated** — separate `messages` array, stashed/restored on mode switch                      |
| `plan`            | Runs through model + plan system prompt; read-only, ends in a written plan    | `planTools()` — read-only (`read`/`list`/`grep`/`glob`)      | shared with agent — `/plan` explore → `/implement` (or `/agent`) executes with plan in context |

Implementation: a single `messages` state holds the active mode's history. When the user crosses the chat boundary (agent/shell/plan ↔ chat), `stashedMessagesRef` saves the outgoing side and restores the incoming side's prior history. Switching among agent, shell, and plan does not stash — they share one history (so a plan carries into agent execution); only chat is isolated. `/new` clears only the current mode's history (the other side's stash survives).

Plan mode's force-write machinery (adaptive novelty cap, reasoning→plan transform with a window-budgeted reference dump) lives in `loop.ts` behind `promptMode === 'plan'`; `REIKA_PLAN_EXPERIMENT=1` just sets the startup mode. It's gated as experimental — keep its constants and helpers together and clearly marked.

Plan→agent handoff distillation (`REIKA_PLAN_HANDOFF=1`, default off, also experimental) addresses the cost of that shared history: the whole plan-mode exploration transcript (raw read payloads + reasoning) carries into agent execution and, on a small window, crowds out the agent's own loop until the plan decays. When on, `distillPlanHandoff` (`agent/compaction.ts`) runs once before the agent round loop and folds the exploration span between the original request and the written plan into a single `compaction` digest, keeping the request and the plan verbatim. It pins on the `planFinal` marker (`types.ts`), set on _any_ final plan-mode message (not just force-writes, so naturally-converged plans fold too); reuses `gatherPlanFindings` for the budgeted digest (`HANDOFF_FINDINGS_FRACTION`, lightweight by default since the agent can re-read on demand); and operates on the per-turn model copy of history like `compactHistory`, so UI scrollback is untouched and it recomputes deterministically each turn. Returns `{folded, reason}` logged every agent turn under `REIKA_DEBUG` so a no-op is classifiable. Same rule as plan mode: keep its constants and helpers together and clearly marked while experimental.

Plan→agent grounding check (`REIKA_PLAN_VERIFY=1`, default off, experimental) attacks the most common cause of the agent loops: a plan that names symbols or files absent from the codebase (renamed, misremembered, hallucinated), which sends the executing agent hunting on 0-match greps or edits whose `old_string` is in no file. When a plan is finalized, `groundcheck.ts` extracts the concrete references it names — file paths and code-y identifiers from _inline_ backticks (fenced code blocks stripped as snippet noise; paths the plan introduces with create-intent verbs or test/spec paths are suppressed), verifies them (paths by `stat`, symbols by one bounded short-circuiting tree walk reusing `tools/_walk`), and appends an advisory listing any not found to the plan message — so it's visible to the user _and_ inherited verbatim by the agent turn. Framed "may be new" (never a hard error; a plan legitimately introduces new symbols) and deliberately one-directional (under-flags rather than over-flags). High-false-flag suppression (`shouldSuppressGrounding`): when nearly everything is missing — most refs unresolved AND ≥4 of them — the note stops discriminating (a greenfield repo or one leaning on external/CDN libs flags _every_ symbol), so it's dropped entirely rather than dumping N noise items that train the agent to ignore it; the debug line records `suppressed=true`. The small high-signal case (a few missing against many found) is left untouched, and since suppression only ever shows _fewer_ flags it can add no false positive — the sole cost is possibly not flagging a real miss where the rate was already too high to discriminate. Same experimental discipline: keep its helpers together and clearly marked.

Plan progress tracking (#68/#71, `agent/plantrack.ts`) keeps the written plan in _harness_ state during implementation instead of trusting the model to stay on track. The tracking layer is **always on and deterministic**: at each agent turn `seedPlanProgress` rebuilds a step checklist from history — the latest `planFinal` message parsed into numbered steps (`parsePlanSteps`, fenced blocks stripped; step lines match plain (`1.`/`2)`/`Step 3:`) AND heading/bold forms (`## Step 1: …`, `**2.** …`) — a heading-styled work step must not vanish while a plain "Verification" list parses — and step numbers are **ordinal**, not the written ones, since sections restart numbering and `n` keys the waive marker; top-level bullets normally merge into the preceding step's body as detail, EXCEPT a bullet quoting a shell command, which promotes to its own step (merged, a trailing "Test checks: • npm test…" list would attach its commands to the last numbered step and a test run would mis-check it), and when the plan has no numbered lines at all its top-level bullets ARE the steps; per step it extracts **paths** (backticked file-looking spans + bare slash-paths; slashless names need a known source/config extension so backticked property access doesn't read as a file), **commands** (backticked spans starting with a known runner — npm/npx/git/…), and **snippets** (backticked code fragments ≥8 chars with a non-identifier char, so bare identifiers — which recur across files as imports/call sites — never qualify)) — with everything observable after the plan replayed. Three check-off signals, all harness-observed facts, tried in order: **path match** (a successful `Edited`/`Wrote` to a file the step names; segment-boundary suffix match, earliest-pending-first so two steps naming one file don't both flip), **content match** (no step names the edited file, but a step-quoted snippet appears verbatim in the edit's diff — this is what rescues the observed failure where the plan pins a change to the WRONG file and the model correctly edits the right one; the check-off receipt says so honestly), and **command match** (an exit-0 bash run — the `Ran:` summary prefix — whose command contains the step's quoted command, whitespace-collapsed so `cd x && …` wrappers still match; this is what lets "run typecheck/tests" steps complete). Same stateless recompute-each-turn discipline as the handoff distillation — no stored state, progress survives across turns for free. A step with none of the three signals displays but can't auto-check and is never enforced. UI: the loop fires `onPlanProgress` snapshots driving `ui/PlanProgress.tsx`, a live checklist in the dynamic region (its exact height is passed to Scrollback as `chromeRows` so the live-region viewport budget accounts for it — unbudgeted it pushes the frame to `stdout.rows` and Ink's full-repaint flicker), plus a persistent `system` receipt per check-off emitted AFTER the tool chip (the signal-lifetime rule: the panel is ephemeral, the scrollback line reconstructs the run). The **model-facing** pieces are gated (`REIKA_PLAN_ALIGN=1`, default off, experimental): `buildPlanProgressLedger` pins the checklist into the regenerated agent system suffix while unchecked steps remain (like the loop ledgers — never in history, so compaction can't age the plan out), and a done-gate (`decidePlanGate`, the plan analogue of the typecheck gate) bounces a turn that tries to finish with enforceable (path- or command-bearing) steps unchecked — once (`MAX_PLAN_GATE_ROUNDS`), with the unfinished steps quoted. Past the budget the leftovers are **waived**, not left pending: an honest third state (`~` in UI and ledger, "reviewed, not observed done") whose step numbers ride the give-up notice as `planWaived` (`types.ts`) so the stateless recompute restores it — without that marker every later turn would re-bounce the same adjudicated step. The gate requires `editingStarted` so a read-only turn (a question about the plan) is never bounced, and runs only after the typecheck gate settles so the two bounded gates can't interleave. Fuzziness is one-directional by design: a missed signal leaves a step manual (under-check); the snippet shape rules keep content matching from over-checking. Same experimental discipline: constants and helpers together in `plantrack.ts`, clearly marked.

URL grounding (`REIKA_URL_GROUNDING=1`, default off, experimental) is the same harness-drives-the-tool move applied to links. A local model sometimes writes a plausible-but-wrong URL into code or a comment — an API endpoint, a docs link, a `fetch()` target — and unlike a hallucinated symbol (caught by typecheck / the plan check above) a bad URL fails silently and only breaks at runtime. So rather than waiting for the model to _choose_ to call `fetch_url`, `tools/_urls.ts` scans the text a write/edit introduces, fetches any http(s) URL on the model's behalf (via `extractUrl`, the shared helper lifted out of the `fetch_url` tool), and appends a note beside the dep-surface block: a ✓ with a short snippet confirms the real page, a ✗ flags a link that does not resolve as "fix this, don't assume it works." Mirrors `tools/_deps.ts` exactly — capped (2 URLs/call), per-turn deduped (`ctx.groundedUrls`, like `resolvedDeps`), fetches run in parallel so wall-clock is one timeout. The point is determinism: the grounded fact arrives in context whether or not the model would have looked it up. Unlike the dep grounder (a silent local read) a URL fetch has external side effects and latency, so it isn't invisible: the grounder returns a user-facing receipt on its result (`ToolResult.notice` for the edit/write path; the `UrlGroundingOutcome.notice` the loop captures for the plan path), and the loop renders it as a standalone `system` scrollback line _after_ the action it describes — `info`/"all reachable" on success, `warn` naming the dead link on failure. Placement matters: the receipt is emitted after the tool chip (or after the plan message), not from inside the tool mid-run, so it reads as a follow-on rather than being stuffed in front of the edit. (This is why grounders return the notice instead of emitting it — tools return data, the loop owns rendering.) It also runs at **plan commit** (`groundUrlsForPlan`, wired beside the symbol/path `groundcheck` at `loop.ts`): a plan can recommend a URL that never reaches a write — a plan-only workflow, or a docs link in prose — which the edit/write hook would never see, so the plan path fetches the URLs the plan names and appends a flag-only note (dead links called out, not snippets — that's `buildPlanUrlNote`, mirroring the symbol advisory) inherited verbatim by the agent turn. Both paths share one core (`groundCandidates`: flag gate, per-turn dedupe, parallel fetch) and differ only in how they render the results into a note. Offline-safe by construction: `extractUrl` distinguishes a server that answered with an error (`reached: true` — a real 4xx/5xx dead link) from a request that got no response at all (`reached: false` — DNS failure, refused, timeout, or no internet). A no-response URL is only called dead when something else in the same batch _did_ reach a server (`batchOnline` — proof of connectivity); with no such proof it's `unverified`, not flagged — so a plan/edit written on an offline machine isn't stamped with phantom "invented URL" warnings (the receipt says "couldn't verify", `info` not `warn`). Same experimental discipline; keep the helpers together and clearly marked.

Mode switches are blocked while `status === 'busy'` to avoid mid-turn state corruption.

When adding new modes, follow the same pattern: decide which existing side it shares with (or define its own stash slot) and update the swap logic in `switchMode()`.

## Approval gate

Mutating tools (`edit`, `write`, `bash`) MUST honor `ctx.requestApproval` if present. When it returns `false`, the tool MUST exit without performing its action and emit a clear summary like `"Edit declined by user for X"`. The `ApprovalRequest` object also accepts optional `warnings` — for `bash`, dangerous patterns trigger warnings that bypass session-auto-approve.

If the tool produces a diff (e.g., `edit`, `write`), include it on the `ToolResult` via `diff: { text, path, added, removed }`. The loop attaches it to the tool message, and `Scrollback` renders the diff under the summary via `DiffView` so the user can see what was actually applied. The diff text uses the `+ `/`- `/`  ` line-prefix format produced by `buildEditDiff` / `buildWriteDiff`.

If the tool ran a shell command (e.g., `bash`), include `command: { text, outputTail, outputTruncated }` on the result. The loop attaches it to the tool message; `Scrollback` renders the command as a `$ <command>` line followed by the last ~10 lines / 2KB of output (with a truncation marker if more existed). Used so the user can reconstruct what auto-approved bash calls actually executed and produced.

**Auto-approve modes:** `REIKA_AUTO_APPROVE` parses to one of three modes (`config.autoApprove: 'off' | 'safe' | 'bypass'`, see `parseAutoApprove` in `config.ts`). `safe` (also `true`/`1`) auto-approves ordinary actions but lets dangerous-pattern commands fall through to the prompt — the warnings break-glass short-circuits inside `requestApproval`. `bypass` (also `yolo`) skips the gate entirely (App passes `requestApproval: undefined` to `runTurn`), so nothing prompts. `off` confirms everything. The session-level toggle (`/approvals on`, or the "Always (this session)" choice during a prompt) flips `sessionAutoApprove`, which grants the same `safe` behavior. Env always wins; the slash command is a no-op when env forces a mode. Status bar shows a yellow `auto approve` indicator under `safe`, and a red `bypass approvals` indicator under `bypass`.

## Post-edit typecheck gate

`src/check/typecheck.ts` runs `tsc --noEmit` after a turn's edits so a weak model doesn't have to remember to verify its own work. It's a **baseline delta**: a pre-edit baseline is captured at the turn's first mutating tool call, the final state is diffed against it (keyed on file + code + message, _not_ line/col, so an edit shifting line numbers doesn't flag pre-existing errors), and only errors the edit _introduced_ are surfaced. On introduced errors the model is sent back to fix them, bounded by `MAX_TYPECHECK_GATE_ROUNDS`; past the cap it finishes dirty with a user notice. TS/JS only — the one ecosystem with a cheap incremental whole-program checker on hand.

**Everything fails open.** No tsconfig, no local `tsc`, a timeout, or a crashed process all resolve to `{ ran: false }`, which disables the gate for that turn — never an error that blocks the loop. The `reason` is REIKA_DEBUG-only; it never reaches the model or the user (so a silently-dead checker can't masquerade as a green check in the logs, but also never nags).

**tsconfig resolution** (`detectTsProject(cwd, fromPath?)`), three fail-open layers: (1) `REIKA_TSCONFIG` env override — explicit escape hatch for layouts auto-detection can't reason about, like references-only solution roots or named-variant-only projects (`tsconfig.web.json`, …) with no plain `tsconfig.json`; honored when it resolves to a real file, a stale value falls through rather than going silent. (2) Walk _up_ from the edited file to the nearest ancestor `tsconfig.json`, bounded at cwd — mirrors tsc's own resolution, so a monorepo edit under `packages/web/` is checked against that package's config even when reika runs at a root with no tsconfig. (3) Degrades to `cwd/tsconfig.json` when there's no `fromPath` or nothing is found. The loop resolves this once (from the first edited file) and pins it for both baseline and final so they diff the same config. Anchoring on the edited file — not globbing config names, not crawling down from root — is what gives "which config?" a single answer; globbing risks pointing `tsc` at a base/partial config that checks nothing and returns a false green, which is worse than not running.

## Loop breaking & spiral handling

Weak/quantized local models loop in two distinct places — repeating **tool calls** and repeating **reasoning** — and the harness has a layered, mostly-experimental response to each. It's all model-invisible instrumentation plus escalating intervention; the hard ceilings (`maxTurns` round cap, the generation backstop) sit under everything and guarantee termination regardless. The detectors only change _what state it stops in_ (a grounded plan / a landed edit / an honest "what's blocking me") versus stopping blindly at a wall.

**Read/tool loops (always on).** `ReadTrace` (`agent/readtrace.ts`) classifies each read as unique / changed / dup-live / dup-aged (REIKA*DEBUG `read-trace` lines). `flagRepeatedCall` (`loop.ts`) appends a soft redirect to a repeated tracked call's payload (read/grep/list/glob/bash). A \_confirmed* loop (recency-gated; dup-live ≥2, dup-aged ≥3) raises a persistent stop directive in the non-aging system suffix via `buildAgentLoopLedger`; if it persists past `LOOP_WITHDRAW_AFTER`, the inspection tools are dropped from the offered set **and refused at dispatch** (an in-band caller routes around a merely-omitted tool, so withdrawal must be enforced where calls are dispatched, not just where they're offered).

**Reasoning loops (`REIKA_REASONING_LOOP=1`, experimental).** `reasoningtrace.ts` measures, over word-level 8-grams, `selfRepeatRatio` (repetition _within_ one block) and `crossRoundSimilarity` (Jaccard _between_ rounds). `ReasoningTrace` tracks the cross-round streak; sustained similarity (≥0.6 for ≥2 rounds) is _rumination_ — the model re-deriving the same analysis while the tool results look new, which the novelty proxy (`planStaleRounds`) is structurally blind to. Two refinements keep this robust to paraphrase-and-oscillate spirals (which dip below 0.6 on a reworded round and would zero a hard streak) without lowering the 8-gram base rate that makes it model-agnostic: each round is compared against a small **window** of the last few rounds (max Jaccard, not just the immediate prior), catching an echo two or three rounds back; and the streak is **leaky** — a still-overlapping round (≥ half the threshold) _holds_ the streak rather than resetting it, so one paraphrased dip can't erase a real loop (holding never _builds_ a streak, so the bar to fire is unchanged). Detection always runs (feeds the REIKA_DEBUG `reasoning-loop` line); the **action** is flag-gated: plan mode gains a third force-write trigger, agent mode drives the same ledger→withdrawal ladder as a read loop.

**Withdrawal asymmetry** (`shouldWithdrawInspection`): a read loop keeps the **edit-recovery exemption** — no withdrawal once editing has begun, because a post-edit re-read is usually re-fetching exact bytes to rebuild `old_string`, not gratuitous looping. A reasoning loop withdraws even post-edit (high crossSim while re-reading is rumination, not recovery) — EXCEPT during edit-recovery itself (an unresolved failed edit genuinely needs reading). The **edit-recovery dead-end** — a reasoning loop on top of a failed edit — splits on the structured failure the edit tool returns (`ToolResult.editFailure`, computed from the same divergence its hint string already reports). A **`diverged`** failure (the anchor block exists, one line differs) is mechanically recoverable, so it gets ONE grounded round first: `buildEditRecoveryLedger` lifts the exact divergence plus the verbatim current bytes into the non-aging system suffix and asks for a single character-for-character fix — the tool's own hint rides in the tool _result_, which ages out under compaction before a period-≥2 loop returns to it, the same reason the loop ledger lives in the regenerated suffix. An **`absent`** failure (`old_string` in no file, typically a plan referencing code that doesn't exist) can't be conjured by re-reading, so it stops immediately. Both bounded like the length/typecheck caps; the grounded round is one-shot (`editRecoveryGroundingTried`) so a still-looping turn falls through to the report next round.

**Agent-mode terminal stop** (`commitAgentLoopStop`, the agent analogue of plan's `commitSpiralStop`): withdrawal only pulls read/grep/glob/list, NOT bash — so a model in a _post-completion verification spiral_ (finished the work, then loops "is it complete? let me check" running `bash tail/grep/wc` with byte-identical reasoning) routes around withdrawal and would run to `maxTurns`. Rather than chase every escape tool, once a confirmed reasoning loop has been through the ledger + withdrawal and still persists `LOOP_TERMINAL_AFTER` rounds (3 — the floor: ledger=1 and withdrawal=2 each get one round, since both genuinely recover _other_ loop types, then terminal at 3; can't go to 2 without skipping the withdrawn call), the turn ends honestly — "made changes to X, edits saved, review them" if it edited, else a stuck-without-progress stop. Self-correcting: heeding either step resets the counter, so terminal only fires on a loop that ignored both. No separate "steer to finish" guard is added on purpose: the withdrawn ledger already says "if complete, say so and stop"; this stuck class ignores it (can't act on directives), and a forced wrap-up call would just re-spiral (it's structurally the force-write) — the terminal writes the completion the model couldn't. This is a third spiral _shape_: can't-find (→ withdrawal forces act/declare), can't-edit (→ edit-recovery dead-end report), and can't-stop (post-completion → terminal report).

**Logit recovery — last resort before the terminal stop** (`REIKA_LOGIT_RECOVERY=1`, experimental; only does anything when reasoning-loop detection is also on, since it fires at that terminal). Before `commitAgentLoopStop`, spend ONE biased round: `logitrecovery.ts` mines the loop's recurring 8-grams (`ReasoningTrace.repeatedShingles`, the intersection it already computes for the Jaccard), tokenizes the top ~12 distinctive words' **entry tokens**, and sends a mild one-shot `logit_bias` (−4, capped at 24 ids, tool-name tokens exempted) to gently down-weight the model's own rut without banning anything. Two things make this safe rather than reckless: it fires at a site that is **structurally pure rumination** (an unresolved failed edit would have stopped/grounded at the earlier edit-recovery dead-end, so the repeated tokens here are filler, not the work — the loop-tokens-≡-work-tokens trap that makes `logit_bias` dangerous on edit loops doesn't apply); and its failure mode collapses to the honest stop — if the biased round still loops, the turn ends exactly as it would have, never as a confident wrong action. The bias is mild + one-shot + capped + tool-exempt precisely so a failed nudge degrades to a no-op, not pollution.

**Plan-mode host — the force-write.** The same one-shot bias also rides plan mode's loop recovery, which isn't a pre-stop round but the **force-write itself** (plan mode's recovery for both a Layer-1 verbatim abort and Layer-2 rumination). It's gated to a LOOP-triggered force-write (`planForceWriteLoopTriggered`) — NEVER the novelty-stall / ceiling convergence, where the model is finishing normally and a bias would only pollute a healthy plan. Two differences from the agent terminal: the bias is **milder** (`PLAN_LOGIT_BIAS = −3`) because this round writes the deliverable, so a polluted-but-not-spiraling _plan_ would ship (where the agent round's pollution only collapses to a stop); and a **null bias just proceeds** with the unbiased force-write — the force-write is the real recovery, the bias is an enhancement — rather than stopping. Token source splits by trigger: cross-round `repeatedShingles` for a reasoning-loop force-write; the **intra-block span** (`repeatedSelfShingles`, the Layer-1 analogue, captured from the degenerate block at verbatim-abort _before_ it's discarded and stashed for the next round) for the verbatim-abort case. This is the path that actually fires on the common single-giant-block spiral — which `verbatim-abort` catches before any cross-round terminal — so it's where the bias earns its keep on a plan-mode workload.

**Symmetry — apply a recovery to both modes' hosts.** Agent and plan mode have different loop-recovery _hosts_: agent's is the pre-stop round before `commitAgentLoopStop`, plan's is the force-write. When you add a recovery intervention (logit bias, edit re-grounding, a steer-to-act nudge), reach the equivalent round in _both_, not just the mode in front of you — the same spiral shapes occur in both, and a one-mode fix silently leaves the other to spiral. The logit recovery is the cautionary example: it shipped agent-only first and never fired on the common single-block plan-mode spiral (which `verbatim-abort` catches long before any agent terminal), so the mode where the user's spirals actually lived got nothing. Two things vary by host and must be tuned per-mode rather than copied: **output-sensitivity** — plan's force-write _is_ the deliverable, so bias milder and let a failure degrade to a no-op, where the agent round can fail to a clean stop; and **token source** — cross-round `repeatedShingles` vs the intra-block `repeatedSelfShingles`, depending on which detector triggered the recovery. The shared gate is always "a _loop-triggered_ recovery round" (`planForceWriteLoopTriggered` in plan mode, the rumination terminal in agent mode) — never a healthy convergence/finish, where intervening only pollutes good output.

**Currently llama.cpp-only, by design.** The token ids come from llama.cpp's native `/tokenize` endpoint (`transport.ts` `tokenize`, at the server root, not under `/v1`), so the recovery is **self-gating**: a backend without that endpoint (e.g. Ollama's OpenAI shim — which also silently ignores `logit_bias`) returns no ids, `buildRuminationLogitBias` yields `null`, and the turn just stops honestly. The tokenizer call is the _only_ engine-specific piece — everything else (`selectBiasWords`, `buildLogitBias`, the `logit_bias` request field) is provider-neutral. It could later be abstracted behind a tokenizer-provider interface (the same shape as `SearchProvider`) to support vllm (which also serves `/tokenize`), MLX, etc.; left concrete until a second engine actually needs it (rule-of-five — don't build the abstraction for one implementation). Same experimental discipline; keep its constants/helpers together and clearly marked.

**Converge retry — a steered last attempt before the stop** (`REIKA_CONVERGE_RETRY=1`, experimental). The honest stops (`commitSpiralStop` in plan, `commitAgentLoopStop` in agent) are the harness _giving up_ on convergence. Before that, spend ONE **steered** retry: a strong, failure-naming directive ("you looped and kept re-questioning yourself; don't overcomplicate; commit to one analysis/action and do it") instead of a cold give-up. Capped at `MAX_CONVERGE_RETRIES` (1 — one strong push; the user can retry fully after), and **worst case is unchanged** — the same stop fires once the budget is spent, we just insert a best-effort push ahead of it. Per the plan↔agent symmetry rule it lands in both hosts: plan mode re-runs the force-write with the steer appended (`buildPlanWritePrompt(steer)`) under a **tighter reasoning ceil** (`STEER_RETRY_REASONING_CEIL`) so an ignored steer is cut fast — cheap-to-fail, and the retry round stays abort-protected via `steerRetryActive`; agent mode appends `buildConvergeSteer` to the terminal round's system suffix. Motivated by a manual finding worth recording: on a plan-mode spiral, two unsteered attempts (one carrying the logit bias) gave up, and a third with exactly this steer ("do not overcomplicate … do not repeat or question yourself") converged in ~500 reasoning tokens where the others spiraled to 18k chars. The lesson generalizes the logit-recovery note: the spiral is a _behavioral_ pattern (the model re-litigating its own analysis), and a natural-language meta-instruction reaches it where token-level bias doesn't — which is why the steer runs _first_ at the agent terminal and the logit bias second. Same experimental discipline; keep its constants/helpers together and clearly marked.

**Intra-block spirals — the live signal.** `liveSpinSignal` runs the windowed `selfRepeatRatio` (12k trailing window — must exceed the repeat period; a small window misses paragraph-recycling) during streaming, debounced (~400 chars), returning `{spinning, ratio}`. The **soft hint (≥0.3, always on)** relabels the busy indicator "Thinking — may be looping (ctrl-c to abort)" and stops there — a _semantic_ spiral can't be judged mid-stream (no way to know it'll escape), so the human decides. The **automated abort** (`REIKA_VERBATIM_ABORT=1`) cuts the round's call mid-flight (on a combined `AbortController` that also forwards user ctrl-c) on either of two conditions: (a) a **length-aware ratio** (`verbatimAbortThreshold`) — 0.75 below ~healthy-max length (16k chars), scaling toward 0.4 as a single block grows (28k chars); the length gate makes the lower bar safe, so genuinely-long _distinct_ reasoning (low ratio) is spared — the discriminator a blunt token cap lacks; or (b) an **absolute length ceil** regardless of ratio (`REASONING_HARD_CEIL`, tighter `FORCE_WRITE_REASONING_CEIL` on the transform round) — catches a _low_-repetition semantic spiral (ratio ~0.3) the ratio curve can't see. The cut reasoning is discarded; recovery is by mode (plan → force-write from findings, agent → nudge), bounded by `MAX_VERBATIM_RECOVERIES`. Crucially the force-write _recovery_ is itself abort-protected (a deeply-stuck model spirals in the transform too): if the force-write spirals or the budget is spent, `commitSpiralStop` ends the turn with an honest "couldn't converge, files examined: …" (not `planFinal`) rather than looping or committing spiral garbage as a plan. This is the only pre-cap backstop for a single never-ending block (the round-level detectors can't run until the round completes, and the `max_tokens` wall can be ~17k+ tokens away on a near-empty context). Tune the curve/ceils against the `verbatim-abort … reason=length|ratio … ceil=` debug fields on real spirals.

**Manual abort keeps partial reasoning.** On a user ctrl-c mid-reasoning the response content is empty, so `commitAborted` would otherwise commit a bare `(aborted)` and discard the model's thinking — leaving a follow-up nudge nothing to build on, exactly when manual recovery is weakest (early turns). It now keeps the partial reasoning (capped most-recent `ABORTED_REASONING_CAP` chars) on the aborted message. (The automated verbatim abort deliberately does the opposite — discards its reasoning as spiral garbage and recovers from findings.)

Reality check the whole subsystem is built around: at Q2 on a vague task the model is ~50/50 to converge vs spiral, and the harness can't move that — it only bounds what the failing half _costs_ (a clean honest stop in minutes, not a 30-minute spiral or a garbage plan). The lever that moves the _rate_ is input clarity / plan grounding, not more intervention code. A clean `commitSpiralStop` is also machine-distinguishable from a converged/wrong plan, so multi-run evals can _count_ outcomes instead of guessing.

Same experimental discipline throughout: keep each subsystem's constants/helpers together and clearly marked while flag-gated, and prefer fixing output-dialect plumbing (`client.ts`) over adding intervention — many "the model is stuck" symptoms have been harness bugs (reasoning-channel markup leaks), not capability.

## Bundle and prompt caching

`ContextBundle` is built once via `bootstrap()` and treated as stable across turns to maximize prompt caching at the provider. Don't mutate it during a session. The only legitimate refresh path is `/cd`, which re-runs `bootstrap()` for a new cwd. If you add a context source, plumb it into `bootstrap()` and the system-prompt builder; never re-fetch per-turn.

**Keep the system prompt provider-neutral.** Don't add model-specific control tokens (e.g., Qwen's `/no_think`, gpt-oss Harmony headers, Mistral instruction tags) to `prompt.ts` — they're junk text for any non-matching model and waste tokens. Inference-engine flags (`--reasoning off` for llama.cpp, `temperature`, etc.) are the right layer for model-specific tuning.

**Prompts are built as string arrays joined with `.join('\n')` / `.join('\n\n')`, not template literals** (`prompt.ts`, `loop.ts` ledgers, `compaction.ts` recaps, etc). Don't "tidy" these into multi-line template literals — it looks cleaner but is the wrong call here. A template literal bakes source indentation into the output (these builders are nested 2 levels deep, so every line would carry leading whitespace — junk tokens the model pays for — unless left-aligned to column 0 or run through a `dedent` helper). The array keeps source-clean and output-clean the same thing for free. It also composes optional sections cleanly — `parts.push(...)` under an `if` (project summary, repo map, plan-mode line) vs. threading `${cond ? … : ''}` ternaries through the prose — and single-sources the separator. Perf is a non-issue at prompt size; this is purely ergonomics + clean output.

## Context management

Three layers keep a long session inside the model's window. They only engage when
`REIKA_CONTEXT_WINDOW` is set (otherwise the gauge shows absolute tokens and nothing is
capped). Each has a non-obvious invariant — don't "simplify" them without reading why:

- **Calibration** (`loop.ts`): the char/4 token estimate (`tokens.ts`) systematically
  under-counts dense tokenizers (code/JSON/CJK). After each call we learn
  `realPromptTokens / estimate` and persist it across turns (turns re-seed the full
  history from the UI scrollback, so the factor must carry over). Everything below uses it.
- **Fit-to-window payload cap** (`toolcall.ts`): fresh tool payloads are truncated to the
  room left after everything else, so a single big tool result can't overflow. The room left
  reserves `minGenTokens` for the model's reply — the same generation reserve compaction and
  the backstop use (see below). Non-fresh content is measured with the _learned_ calibration;
  the fresh allowance is converted to chars with a pessimistic floor (`CAP_DENSITY_FLOOR`) so
  a sudden dense dump can't overflow while calibration lags. The truncation marker says
  "context limit, not a command error" on purpose — without it, models loop re-running with
  different shell flags.
- **Compaction** (`compaction.ts`): once the calibrated estimate crosses
  `(window − minGenTokens) × 0.9` — i.e. when the prompt would leave less than the generation
  reserve (plus slack) — the oldest turns fold into one recap message (merged into the system
  block), keeping recent turns verbatim. It snaps the keep-boundary _back_ over `tool` messages
  to a tool-call-group start (so no tool result is orphaned from its `tool_call`) and pins the
  original user task verbatim, recapping only what follows. Snapping back rather than forward to
  a user message is what lets it compact _within_ a single long turn — e.g. a read-heavy
  plan-mode exploration that has one user message and no later boundary; the old user-only snap
  found nothing and no-op'd, so the request grew unbounded. Keep/recap budgets are sized off the
  _available_ room (`window − minGenTokens`), not the full window, so the result fits under the
  trigger even when the reserve is a large fraction of a small window. It runs on the loop's
  local history copy; the UI scrollback is untouched.
- **Generation backstop** (`budget.ts`): each turn the loop computes `max_tokens =
window − calibratedPrompt − margin` (or the fixed `REIKA_MAX_TOKENS`, whichever is smaller)
  and passes it to `callModel`. It caps a spiraling small/quantized model so it can't run to
  the context end. The cap is a _ceiling_; `minGenTokens` is the _floor_, enforced upstream
  by compaction keeping the prompt under `window − minGen` — so on a normal turn the ceiling
  already lands ≥ the floor and the cap never fires. One number, `REIKA_MIN_GEN_TOKENS`
  (default 2048), drives all three: the cap reserve, the compaction trigger, and this floor.
  Size it ~2048 for reasoning-off models, 6144–8192 for reasoning-on thinking models on a
  small window.

**Reasoning pruning** (`toolcall.ts`): historical `reasoning_content` is kept only for the
last `REIKA_REASONING_ROUNDS` tool-call rounds (default 2; the active roundtrip is always
among them — see the cross-provider note) and dropped elsewhere. Unbounded, a thinking model
accumulates reasoning every round and starves the budget; pruned to 1, it re-derives the same
analysis across rounds (and a `repeat_penalty` can't suppress what's no longer in-window).
Keeping a small recent window is the balance — raise the env var to trade tokens for
chain-of-thought continuity, lower it under context pressure.

## .gitignore is honored

Bootstrap loads `.gitignore` (and `.git/info/exclude`) into an `Ignore` instance on `bundle.ignore`. Any walker that touches the filesystem MUST consult it: `buildFileIndex` (fdir exclude+filter), `buildRepoMap` (manual walk), `list` / `grep` / `glob` tools (via `ctx.ignore`). New walkers added to tools or context modules MUST do the same — otherwise the agent burns exploration on build outputs.

## Config sources

`loadConfig()` reads dotenv from cwd `.env` first, then `~/.config/reika/.env` as fallback. Shell env vars take precedence over both (dotenv's no-override default). Order matters — don't reorder without thinking about precedence.

## Profiles

`Config.profiles` is a map of named `Profile` objects (`model` + `baseURL` + `apiKey`). The "default" profile is always present, derived from the flat `REIKA_MODEL`/`BASE_URL`/`API_KEY` keys. Additional profiles come from `REIKA_PROFILES=kimi,gpt4` + per-profile `REIKA_<NAME>_MODEL` etc.

When calling `runTurn`, App.tsx passes `resolveProfile(config, activeProfile)` rather than raw config — that overlays the active profile's `model`/`baseURL`/`apiKey` onto the rest. `/model <name>` updates `activeProfile`. Profile names are lowercased on load; matching is case-insensitive.

Subagent overrides (`REIKA_SUBAGENT_*`) are independent of profiles — they always come from the top-level config regardless of which profile is active. This is intentional: subagent model selection is a separate axis from main-thread model selection.

**Per-profile `maxTokens`:** an _explicit_ ceiling on response tokens, falling back to the global `REIKA_MAX_TOKENS`. It is no longer the only source of `max_tokens`: when `contextWindow` is set, the loop computes a per-turn backstop (`window − prompt − margin`, see the Generation backstop above) and sends `min(REIKA_MAX_TOKENS, backstop)`. With no window known and no `REIKA_MAX_TOKENS`, `max_tokens` is omitted (server default). An explicit `REIKA_MAX_TOKENS` still wins as a hard cap, so setting it too low truncates tool-call JSON silently — keep ≥4k for tool-heavy use, or just leave it unset and let `minGenTokens` size the reserve.

**Per-profile `minGenTokens`** (`REIKA_<NAME>_MIN_GEN_TOKENS`): the generation reserve, falling back to the global `REIKA_MIN_GEN_TOKENS` (default 2048). One number drives the cap reserve, the compaction trigger, and the backstop floor — set it larger (6144–8192) on a small-window profile running a reasoning model so compaction fires early enough to leave think-room.

## Tests (Vitest)

`npm test` runs all unit tests (sub-second). Covered modules with bug-prone pure logic:

- `src/provider/toolcall.ts` — `messagesToOpenAI` (assistant content nulling, tool message `name` field, payload aging)
- `src/provider/client.ts` — `sanitizeToolName`, `extractToolCallsFromContent`
- `src/ui/suggest.ts` — command + file autocomplete matching
- `src/ui/summary.ts` — session stats derivation
- `src/agent/mentions.ts` — `@filepath` expansion
- `src/search/searxng.ts` — provider request shape + response normalization (fetch mocked)

**Not covered (deliberately):** UI components (Ink testing is awkward; evals own end-to-end behavior), tools that wrap node fs/process (read/list/grep/edit/write/bash — shallow wrappers), the agent loop itself (evals territory).

**When editing a covered module, run `npm test` before declaring done.** Tests catch regressions evals can't (evals only run when a real model invokes the broken path).

## Skills

Markdown files in `~/.config/reika/skills/` (global) and `<cwd>/.reika/skills/` (project) load as slash commands at bootstrap. Two layouts supported: a flat `name.md` file, or a directory `name/SKILL.md` (Claude Code convention — lets a skill carry supporting files which we ignore). Loader in `src/skills.ts`; bootstrap attaches the resulting `Skill[]` to `bundle.skills`. App.tsx `handleCommand` falls through to skill dispatch when no built-in matches — built-ins always shadow skill names.

When invoked, the skill body is sent as the user message (verbatim), with any args appended after a blank line. The display in scrollback shows the raw `/skill args` the user typed, not the expanded body. Uses the same `submitToModel` path as regular input, so streaming/abort/approval all work identically.

Filename validation: `[a-z0-9][a-z0-9_-]*` only. Frontmatter (optional) is parsed with a tiny hand-rolled key:value parser — no `js-yaml` dep. Per the rule-of-five heuristic, the parser isn't worth a library until skills grow nested/complex metadata.

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

- Reika sends no sampling params so some models may need their sampling parameters tweaked (server-side) in order to reduce issues like endless loops. Not a context bug; a single runaway completion can't be interrupted between calls. The sole exception is the experimental logit recovery (`REIKA_LOGIT_RECOVERY`), which sends a one-shot `logit_bias` on a single last-resort round only — see Loop breaking & spiral handling; normal turns still send nothing.
- The char/4 token estimate (`tokens.ts`) under-counts dense tokenizers — the context cap/compaction correct for it via a learned calibration plus a density floor on the cap (`CAP_DENSITY_FLOOR`). Don't drop the floor: it's what stops a dense tool dump overflowing before calibration catches up.
- Some cloud thinking models require `reasoning_content` to be roundtripped on assistant messages with tool_calls — handled in `src/provider/toolcall.ts`
- GPT-OSS on some inference engines leaks `<|channel|>` Harmony markers in tool-call names — `sanitizeToolName()` in `src/provider/client.ts` strips them defensively.
- Models without a native tool-calling template fall back to emitting calls as text; `extractToolCallsFromContent` (`client.ts`) parses the dialects (`<tool_call>{json}`, Hermes `<function=…>`, pythonic `fn(k=v)`). Thinking models sometimes leak the call into the `reasoning_content` channel instead of `content` — `callModel` recovers it from reasoning when content is empty, so the turn doesn't stall. Prefer a native template; these parsers are the fallback.
- Some chat templates hard-require a user message and raise without one (e.g. ornith-1.0-35b on llama.cpp → 400 "No user query found in messages"). Compaction folds user turns into the system recap and meta (slash-echo) turns are skipped, so a heavily-compacted long turn could otherwise send a request with no user message at all. `messagesToOpenAI` guarantees one: when no user turn would be emitted it surfaces the recap as a user message instead of folding it into system (it carries the original task via `buildRecap`'s `- User:` line), with a final `(continue)` backstop if there's neither a user turn nor a recap.
