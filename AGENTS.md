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
| `src/context/`  | Bootstrap, repo map (per-language regex table), file index (fdir-based), gitignore          |
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
5. Unit-test the logic the wrapper adds (caps, windows, footers — not the syscall), and add an eval fixture only if the question is whether a _model_ uses the tool correctly. See "Choosing a test instrument"

## Optional tools and provider abstractions

When a tool wraps an external service (web search, GitHub, etc.):

- Put the provider abstraction in its own subdir (e.g. `src/search/types.ts` with `SearchProvider` interface; per-provider adapters next to it)
- The tool file (`src/tools/search.ts`) is a thin factory that takes a provider and returns a `Tool`
- Register conditionally in `defaultTools(config)` based on which credentials are present
- Multiple providers for the same role (SearXNG, Brave, Exa…) could implement the same interface; switching is config-only, no tool-layer changes

This is how `search` is wired. Two providers implement `SearchProvider`, both local-first — no third-party tool-use APIs, no credentials. `SearxngProvider` proxies a self-hosted SearXNG instance. `CdpSearchProvider` (#235, `REIKA_CDP_SEARCH=1`) drives a real Chrome over CDP instead, and **outranks SearXNG in `makeSearchProvider` when both are configured**: SearXNG reaches engines as a bare HTTP client, which is the shape they CAPTCHA — a measured instance had all four of its engines refused (`unresponsive_engines`: CAPTCHA, suspended) on even a three-word query — where a browser on a persistent profile keeps being served. If neither is configured, `search` doesn't register and the system prompt stays lean. `fetch_url` is **not** gated with it — it needs no provider, and the harness hands the model URLs (pasted-link expansion, URL grounding) that it must be able to follow up on.

**CDP search (`REIKA_CDP_SEARCH=1`, default off).** `search/_chrome.ts` owns the browser (discovery, launch, reattach, idle shutdown) behind a `BrowserHost`/`TabHandle` interface plus a dependency-free CDP client — Node ships a global `WebSocket`, so the protocol is an id, a send, and a map of pending resolvers. `search/cdp.ts` is the provider: navigate, extract, parse. The split is what makes the provider unit-testable without a browser on the machine running the suite.

Four decisions worth not re-litigating:

- **Brave, not Google.** Measured on live SERPs: Google and Bing launder every outbound link through an opaque tracker (`google.com/goto?url=…`, `bing.com/ck/a?…`) — 0 of 53 and 0 of 46 visible links survive to a usable URL, and `cite` is a display string, not a fallback. Brave and DDG return real hrefs. Brave also runs its own index rather than reselling Bing, so it isn't correlated with the engine most likely to block us next.
- **Not headless, but minimized.** A fresh headless profile is the shape engines CAPTCHA. macOS `open -g -na` starts a real browser that never takes focus, and `newTab` then minimizes its window over CDP (`Browser.setWindowBounds`) — enforced per tab rather than per launch, because a reattached browser is in whatever state the last session left it. Extraction works from a minimized window (measured: 8 results, 81 links). The persistent `--user-data-dir` (`~/.config/reika/chrome`) is the anti-CAPTCHA mechanism, not an implementation detail.
- **A bot check is a gate a human opens, once (#238).** It does not clear on its own, and the solve persists on the profile (observed: one manual solve, served normally since). So the provider does not retry with backoff — it restores the window and `Page.bringToFront`s the challenged tab (app-level activation would raise the user's own Chrome; this is a separate instance), reports `raised` through `SearchOptions.onChallenge`, and polls the tab until it stops looking like an interstitial, then minimizes again and answers the _same_ search — no budget spent on a retry, nothing latched. The wait is bounded (`CHALLENGE_WAIT_MS`, two minutes) because nobody may be at the desk; on expiry it fails the turn as before, with the tab left open and raised so the check can still be completed later. One solve at a time: parallel searches are refused together and the solve is profile-wide, so the first raises and the rest wait on its promise, then reload. The tool owns the presentation: a live line while the window is up, a persistent `info` receipt after — the results alone would not show a human stepped in.
- **The extractor is deliberately structure-agnostic**: every visible `a[href]`, filtered, deduped, capped at two per host (a result with a nested issues/discussions cluster otherwise contributes a run of same-host links that crowds out everything ranked below it). No result-card selectors, so a SERP redesign degrades quality rather than silently emptying the results.
- **A refused search must not read as an empty one** — #236's rule, and the reason detection has a structural half: the challenge that prompted it says "Verifying you're not a bot", which no obvious phrase list would have caught, so a page carrying almost no links is reported as an interstitial regardless of its wording. `waitForReady` probes the committed `location.href` alongside `readyState` for the same reason: `readyState` reads `complete` for the document still on screen while a navigation is in flight, and extracting from the `about:blank` a new tab starts on looks exactly like a search that found nothing.

**Provider-level search failures latch for the turn (#239).** `SearchUnavailableError` (`search/types.ts`) marks a failure that is a property of the _provider_ rather than the query — no browser found, a bot check, every SearXNG engine refused — as against an ordinary throw, which stays query-level (one unparseable page) and leaves the next search free to run. On catching it the tool records the reason in `ctx.webHealth` (per-turn, shared by reference like `webBudget`) and every later search that turn returns it without re-attempting, worded as _still_ unavailable so it doesn't read as a fresh problem. Without this a three-search turn spends all three on one condition that refuses every query identically — the exact spiral #236 was about, one level up: there the model couldn't tell a block from an empty result, here it can't tell a block from a _transient_ one.

**The network being down latches both web tools (#392).** Nothing checks connectivity up front — a probe is a snapshot, and an outbound request at startup is the wrong shape for a local-first tool — so the first failed call is the detector. `fetch_url` dug a socket-level `code` out of undici's `cause` chain (`tools/_net.ts`; the outer text is always `fetch failed`, which reads to a model as "try again"); a code that means _no route_ (`ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`) sets `ctx.webHealth.offline`, and every later `fetch_url` _and_ `search` that turn is skipped without a request or a budget slot, worded as _still_ offline. A host-specific failure — `ECONNREFUSED`, a timeout, TLS — stays per-call: one bad server is not an outage, and a turn latched on it would give up on the next good URL. SearXNG's own instance being unreachable is a `SearchUnavailableError` (one host; rewording cannot bring it up), taking the provider latch above. The startup half is cheaper still: `isOffline()` reads the interface table (zero egress; link-local excluded because macOS keeps `fe80::` on `utun`/`awdl` with the radio off) and, when nothing routes out, `defaultTools`/`chatTools` register neither web tool for the session, with a `warn` line in the scrollback saying so. Held for the session on purpose — the tool list is in the round-0 prefix, and toggling it mid-session blows the KV cache (#69/#81); a drop after startup is the per-turn latch's job.

Two details that follow from what the budget is for. A refused search is **refunded** (`budget.used--`): the cap exists to stop runaway loops hammering upstream engines, and a search that never reached an engine — a missing Chrome reaches nothing at all — is not that egress. And the error's optional `remedy` is surfaced through `ToolResult.notice` (user-facing, `warn`), never in the summary: the model cannot set an environment variable, so naming one in its context is noise it can only ignore, while the user is the one who can act. Emitted once, on the failure that sets the latch.

**Per-turn budget for web tools:** `runTurn` creates a `webBudget` object once per user turn and passes it through `ToolContext`. `search` and `fetch_url` increment their respective counter before running; if at max, return a budget-exceeded summary without actually calling the upstream. **Harness-driven fetches count too:** URL grounding (`groundCandidates`) charges the same `fetches` counter, because a fetch the model never asked for is still egress — without it, N edits in a turn was up to 2N requests the runaway guard never saw. It differs only in how it declines: grounding takes whatever budget is left (possibly none) and stays silent, where a tool returns a refusal summary — nothing requested the grounding fetch, so there is nobody to report a refusal to, and the note would be context noise. This prevents runaway model loops from hammering SearXNG (which proxies to Google/Bing — they rate-limit per IP, so a runaway agent can get your queries blocked at the upstream level). Caps are configurable via `REIKA_MAX_SEARCHES_PER_TURN` and `REIKA_MAX_FETCHES_PER_TURN`. Subagents get their own fresh budget (independent `runTurn` invocation).

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

### The live region during a subagent

A subagent streams into the parent's live region (#342): `makeSpawnSubagent` forwards every streaming/phase callback and brackets the run with `onSubagent(true|false)`, which `App` turns into `streamingNested` on `Scrollback`. The parent is blocked inside the tool call with its own assistant message already committed, so the region is empty for the whole run — there was never anything to keep it "clean" from, and withholding the callbacks made a subagent a silent block that rendered each round as a batch on commit. Nested live blocks draw at `NESTED_INDENT` inside the same margin-plus-explicit-width box `MessageView` gives a nested committed row, so the streaming tail sits exactly where its committed row lands; the top-level live region is left byte-identical (the wrapper only exists when nested). On return the phase is reset to `'tool'` — the parent is still dispatching that round.

### Atomic frames (`ui/syncframe.ts`, #345)

Ink paints a frame as `eraseLines + output`, and a `<Static>` commit is three writes (erase the
live region, write the committed rows, redraw the live region). The terminal may paint between
any two of them, and a 7KB frame arrives over the pty in several reads anyway. Invisible when the
process is on-CPU; under memory pressure (a 27B model on a 16GB machine swapping this process out
between writes) the erased state gets painted and the UI flickers. `cli.tsx` therefore renders to
`createSyncedStdout(process.stdout)`: every write in a tick is coalesced into one `stream.write`
(Ink issues a frame's writes synchronously, so the microtask boundary is the frame edge) and
wrapped in DEC private mode 2026, which makes a supporting terminal buffer until the closing
sequence and paint once. Measured over a pty on a full tool-call turn: 314 writes → 285, every
one a balanced BSU…ESU frame, ~1% more bytes. The `process.exit` hook flushes synchronously and
then passes later writes straight through — the focus-report reset and Ink's final frame land
after it, with no tick left to run a queued flush. A pipe (tests, CI) gets the raw stream, so
render tests never see the sequences. `REIKA_SYNC_OUTPUT=0` is the kill switch. Everything but
`write` reads through to the real stream, so `columns`/`rows`/resize are the same whichever handle
a component holds.

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

| Mode              | Input behavior                                                                | Tools                                                                                                          | History                                                                                        |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agent` (default) | Runs through model + agent system prompt                                      | `defaultTools(config)` — full set                                                                              | shared with shell + plan                                                                       |
| `shell`           | Runs as bash directly (no model)                                              | n/a                                                                                                            | shared with agent — shell output becomes part of agent's context                               |
| `chat`            | Runs through model + lean chat system prompt (no tool-use rules, no repo map) | `chatTools(config)` — knowledge-only (`search`, `fetch_url`)                                                   | **isolated** — separate `messages` array, stashed/restored on mode switch                      |
| `plan`            | Runs through model + plan system prompt; read-only, ends in a written plan    | `planTools()` — read-only (`read`/`list`/`grep`/`glob`, plus a read-only `bash`; `REIKA_PLAN_BASH=0` drops it) | shared with agent — `/plan` explore → `/implement` (or `/agent`) executes with plan in context |

Implementation: a `messages` state holds the active mode's **scrollback**, and `modelHistoryRef` holds the **model-facing** history beside it — the same message objects, but only what the model sees (no `system` notices, `header`s, `shell` blocks or command echoes) and with the loop's rewrites applied. The loop mutates that array in place, so a compaction or handoff fold **persists across turns** (#183): seeding each turn from the scrollback instead re-expanded every fold, redoing the work and rewriting the recap in the system block — a from-token-0 re-prefill at every turn boundary. Scrollback is never folded (`/save` keeps the full transcript); model history is never shown. When the user crosses the chat boundary (agent/shell/plan ↔ chat), `stashedMessagesRef` saves and restores both sides. Switching among agent, shell, and plan does not stash — they share one history (so a plan carries into agent execution); only chat is isolated. `/new` clears both sides (a stash resurfacing after a "new session" receipt would contradict it). Note that `messages` is therefore NOT append-only, but the terminal is: `Scrollback` feeds `<Static>` an append-only log keyed by message identity (`useScrollbackLog`), so each message prints once when it first appears and a swap prints only its new trailing rows. Handing `<Static>` the swapped array directly swallowed the mode banner and the `/new` receipt whenever the new array was no longer than the old one (#385).

Plan mode's force-write machinery (adaptive novelty cap, reasoning→plan transform with a window-budgeted reference dump) lives in `loop.ts` behind `promptMode === 'plan'`; `REIKA_PLAN_EXPERIMENT=1` just sets the startup mode. It's gated as experimental — keep its constants and helpers together and clearly marked.

Plan→agent handoff distillation (on by default since 2026-09-19; `REIKA_PLAN_HANDOFF=0` is the baseline arm) addresses the cost of that shared history: the whole plan-mode exploration transcript (raw read payloads + reasoning) carries into agent execution and, on a small window, crowds out the agent's own loop until the plan decays. When on, `distillPlanHandoff` (`agent/compaction.ts`) runs once before the agent round loop and folds the exploration span between the original request and the written plan into a single `compaction` digest, keeping the request and the plan verbatim. It pins on the `planFinal` marker (`types.ts`), set on _any_ final plan-mode message (not just force-writes, so naturally-converged plans fold too); reuses `gatherPlanFindings` for the budgeted digest (`HANDOFF_FINDINGS_FRACTION`, lightweight by default since the agent can re-read on demand); and operates on the persistent model history like `compactHistory`, so UI scrollback is untouched and the fold survives to the next turn (its `already-distilled` guard makes the per-turn re-run a no-op). Returns `{folded, reason}` logged every agent turn under `REIKA_DEBUG` so a no-op is classifiable. Went default-on unmeasured, on the risk profile rather than an A/B: it is a no-op without a `planFinal` message, touches only the persistent model history, and its worst case — an under-reporting digest — is the ordinary compaction worst case the agent already re-reads past. Keep its constants and helpers together and clearly marked.

Plan→agent grounding check (`REIKA_PLAN_VERIFY=1`, default off, experimental) attacks the most common cause of the agent loops: a plan that names symbols or files absent from the codebase (renamed, misremembered, hallucinated), which sends the executing agent hunting on 0-match greps or edits whose `old_string` is in no file. When a plan is finalized, `groundcheck.ts` extracts the concrete references it names — file paths and code-y identifiers from _inline_ backticks (fenced code blocks stripped as snippet noise; paths the plan introduces with create-intent verbs or test/spec paths are suppressed), verifies them (paths by `stat`, symbols by one bounded short-circuiting tree walk reusing `tools/_walk`), and appends an advisory listing any not found to the plan message — so it's visible to the user _and_ inherited verbatim by the agent turn. Framed "may be new" (never a hard error; a plan legitimately introduces new symbols) and deliberately one-directional (under-flags rather than over-flags). High-false-flag suppression (`shouldSuppressGrounding`): when nearly everything is missing — most refs unresolved AND ≥4 of them — the note stops discriminating (a greenfield repo or one leaning on external/CDN libs flags _every_ symbol), so it's dropped entirely rather than dumping N noise items that train the agent to ignore it; the debug line records `suppressed=true`. The small high-signal case (a few missing against many found) is left untouched, and since suppression only ever shows _fewer_ flags it can add no false positive — the sole cost is possibly not flagging a real miss where the rate was already too high to discriminate. Same experimental discipline: keep its helpers together and clearly marked.

Plan progress tracking (#68/#71, `agent/plantrack.ts`) keeps the written plan in _harness_ state during implementation instead of trusting the model to stay on track. The tracking layer is **always on and deterministic**: at each agent turn `seedPlanProgress` rebuilds a step checklist from history — the latest `planFinal` message parsed into numbered steps (`parsePlanSteps`, fence-aware — fenced numbering/bullets are snippet content, never steps; step lines match plain (`1.`/`2)`/`Step 3:`), heading/bold forms (`## Step 1: …`, `**2.** …`), and dash-delimited headings (`Step 1 — Title`, gated on the literal "Step" keyword since bare "1 — option" is prose-comparison shape) — a heading-styled work step must not vanish while a plain "Verification" list parses — and step numbers are **ordinal**, not the written ones, since sections restart numbering and `n` keys the waive marker; top-level bullets normally merge into the preceding step's body as detail, EXCEPT a bullet quoting a shell command, which promotes to its own step (merged, a trailing "Test checks: • npm test…" list would attach its commands to the last numbered step and a test run would mis-check it), and when the plan has no numbered lines at all its top-level bullets ARE the steps; per step it extracts **paths** (backticked file-looking spans + bare slash-paths; slashless names need a known source/config extension so backticked property access doesn't read as a file), **commands** (backticked spans starting with a known runner — npm/npx/git/… — plus bare unmarked command lines and shell-ish fenced blocks in the step body, both on a stricter runner list that drops the English-word runners `go`/`make` so "go to the settings page" can never become an enforceable command; tagged code fences like ```go contribute nothing; non-terminating shapes — dev/start/serve/watch/preview — are excluded in every context, since a dev server never exits 0 and its "verify visually" step is a human step that must stay unenforced), and **snippets** (backticked code fragments ≥8 chars with a non-identifier char, so bare identifiers — which recur across files as imports/call sites — never qualify)) — with everything observable after the plan replayed. Three check-off signals, all harness-observed facts, tried in order: **path match** (a successful `Edited`/`Wrote`to a file the step names; segment-boundary suffix match, earliest-pending-first so two steps naming one file don't both flip), **content match** (no step names the edited file, but a step-quoted snippet appears verbatim in the edit's diff — this is what rescues the observed failure where the plan pins a change to the WRONG file and the model correctly edits the right one; the check-off receipt says so honestly), and **command match** (an exit-0 bash run — the`Ran:`summary prefix — whose command contains the step's quoted command, whitespace-collapsed so`cd x && …`wrappers still match; this is what lets "run typecheck/tests" steps complete). Same stateless recompute-each-turn discipline as the handoff distillation — no stored state, progress survives across turns for free. A step with none of the three signals displays but can't auto-check and is never enforced. UI: the loop fires`onPlanProgress`snapshots driving`ui/PlanProgress.tsx`, a live checklist in the dynamic region (its exact height is passed to Scrollback as `chromeRows`so the live-region viewport budget accounts for it — unbudgeted it pushes the frame to`stdout.rows`and Ink's full-repaint flicker), plus a persistent`system` receipt per check-off emitted AFTER the tool chip (the signal-lifetime rule: the panel is ephemeral, the scrollback line reconstructs the run). The **model-facing** pieces are gated (`REIKA_PLAN_ALIGN=1`, default off, experimental): `buildPlanProgressLedger` pins the checklist into the regenerated agent system suffix while unchecked steps remain (like the loop ledgers — never in history, so compaction can't age the plan out), and a done-gate (`decidePlanGate`, the plan analogue of the typecheck gate) bounces a turn that tries to finish with enforceable (path- or command-bearing) steps unchecked — once (`MAX_PLAN_GATE_ROUNDS`), with the unfinished steps quoted. Past the budget the leftovers are **waived**, not left pending: an honest third state (`~`in UI and ledger, "reviewed, not observed done") whose step numbers ride the give-up notice as`planWaived` (`types.ts`) so the stateless recompute restores it — without that marker every later turn would re-bounce the same adjudicated step. The gate requires `editingStarted`so a read-only turn (a question about the plan) is never bounced, and runs only after the typecheck gate settles so the two bounded gates can't interleave. Fuzziness is one-directional by design: a missed signal leaves a step manual (under-check); the snippet shape rules keep content matching from over-checking. Same experimental discipline: constants and helpers together in`plantrack.ts`, clearly marked.

Read-first edit gate (#72, `REIKA_READ_FIRST=1`, default off, experimental — `agent/readfirst.ts`) attacks the other common agent dead-end: a _blind_ edit — an `edit` to a file the model hasn't `read` (and hasn't successfully `edit`/`write`-ed) this turn — whose `old_string` is guessed from memory and mismatches the real bytes, which then loops on the failure. `ReadFirstGate` tracks per-turn grounded paths (`ground` on any read/successful write, `shouldBounce` on an edit to an ungrounded one) and is recorded **unconditionally** (cheap); only the flag lets it _withhold_. When on, the first blind edit per file is bounced once: the tool call is replaced with `buildReadFirstDirective(path)` telling the model to read the file and re-issue the edit from its actual bytes — reading first instead of reasoning about an `old_string` failure after the fact. One bounce per file per turn (the gate grounds the path on the directive, so a re-issued edit always runs), and the bounce suspends the loop-withdrawal ladder for that round so the redirect isn't miscounted as a tool-call loop. Fail-open by construction. Same experimental discipline: constants and helpers together in `readfirst.ts`, clearly marked.

Subagent nudge (#273, `REIKA_SUBAGENT_NUDGE=1`, default off, experimental — `agent/prompt.ts`) is one agent-prompt line, a _routing_ rule at rule 3, keyed on the request's shape: trace/explain/summarize-across-files → the FIRST call is `subagent`, with the paths and symbols the model already knows and "report the chain with file and function names, not line numbers" (the arm-2 parent asked for exact line references unprompted, and pinning them is what drove its subagent to read `types.ts` in 14 slices — #340/#341); one-or-two-file questions are read directly. The first arm was permission-shaped in rule 7's image ("when answering needs more than ~3 files, hand it to subagent") at the tail of the list: 0/2 uptake on qwen3.8-27b, reasoning never mentioned the tool. Its trigger was a forecast — how many files WILL this need — and this class of model takes the obvious next step (rule 2, grep) instead of predicting, then rules 2–3 keep it exploring; rule 7 works because its trigger is an observation. The same runs showed the model naming the five files it needed before its first call, so the task string a subagent needs is something it can already write — the trigger failed, not the mechanism. The value being bought is context, not speed: N reads through a subagent land in the parent as ONE digest payload instead of N, and payload crowding is what evicts the task spec on a small window (#276). Scoped to exploration, never edits — a delegated edit is one the parent never read the file for. Rules are numbered at join time, so the optional line shifts the ones after it (the `ask_user` rule is 7 off-flag, 8 on). Keyed off the tool list through `canSubagent` exactly as the ask rule is off `canAsk` (both `buildRoundZeroPrefix` and `runTurn` derive it from the same `tools` array, or the warm prefix drifts), so a subagent (no recursion) and plan mode (no `subagent` tool) never see it; with the flag off the prompt is byte-identical. Known cost on a single-slot server: the subagent's system prompt differs from the parent's, so its request evicts the parent's KV prefix and the parent re-prefills its whole context on resume.

Subagent bounded return (#340, always on — `agent/subagentreport.ts`, wired in `runTurn` via `reportAtCap` and in `makeSpawnSubagent`). A subagent's end product is a report, exactly as plan mode's is a plan, and it needs the same closure signal: the #273 arm-2 subagent ran 90 minutes under aging ("the body is now hidden, need to re-read"), read one file in 14 slices, and handed the parent `(aborted)`. On the subagent's last budgeted round (`i === maxTurns − 1`) the loop forbids calls with `tool_choice: 'none'` while keeping the tool list in the request (#426 — see the report-round note below), drops any call that arrives anyway (the plan force-write mechanics, without the transform), and composes `SUBAGENT_REPORT_DIRECTIVE` LAST in the suffix so it wins over every ledger above it — all of which say some form of "keep working". The reply is the digest; an empty content channel falls back to the reasoning channel. Partial and grounded beats nothing. The parent turn keeps its honest-exhaustion message — `reportAtCap` is only ever set by `makeSpawnSubagent`. Two things ride the digest back: **a coverage note** (`buildCoverageNote`) — files the task named (bare paths in prose, `extractTaskPaths`; the plan grounder's backtick-only extraction would see none of them) minus files the subagent `read` (any range; grep hits don't count) — phrased as an observation with a re-spawn cue, because the observed parent failure was planning to "verify myself", reading the remainder into the context the subagent was meant to protect; and **a per-turn cap** (`MAX_SUBAGENTS_PER_TURN = 3`, counted in `runTurn` since the ToolContext is rebuilt per call) so the re-spawn cue can't become an unbounded loop — each spawn evicts the parent's KV prefix on a single-slot server. The cap counts _decisions_ — rounds that dispatched a subagent — not calls (#354): a parent that decomposed a task into four stage-wise subagents in one round (observed, nudge off, right after a compaction fold) had made one decision, and a per-call cap refused the fourth stage. Width within a round is bounded separately (`MAX_SUBAGENTS_PER_ROUND = 4`); on one slot the calls run one after another, so width is wall-clock. **Aged reports keep their head** (`reportHead` in `provider/toolcall.ts`, `AgedKind 'report'`, `REPORT_HEAD_CHARS = 2400` — sized like a compaction note, the same class of artifact): a report is already a digest, and aging it to `Subagent completed (5165 chars)` destroyed the one thing that was already compressed and sent the parent back to the files the subagent had read. Head-first because the report directive puts the chain first and "Not covered" last. Detected by the tool's summary shape, the way `readSkeleton` keys on a read's. `REIKA_SUBAGENT_MAX_TURNS` should stay tighter than `REIKA_MAX_TURNS`; `.env.example` ships 8, not the old 500.

A subagent call is exclusive in its round (#346, always on — `SUBAGENT_HOLD_NOTE` in `agent/subagentreport.ts`, enforced at dispatch in `runTurn` next to the withdrawal refusal). The first bounded-return run had the parent "call subagent (mandatory first call) and read a few core files in parallel": four fresh payloads shared the window on the next round and all four were truncated — including the 6400-char report — after which the parent re-read files the report had already covered because its own capped copies looked incomplete. So when a round's calls include `subagent`, sibling inspection calls (the withdrawal ladder's set: `read`/`grep`/`glob`/`list`, plus an inspection-shaped `bash`) do not execute; each returns the note in place of its result (no content, cf. `WITHDRAWAL_DIRECTIVE`). Decided over the whole round up front, so siblings are held on either side of the subagent call; NOT when the spawn itself would be refused by the per-turn cap (the model would be left with nothing that round); mutating siblings are out of scope. Held calls skip the repeat detector, so a real read of that path later is not a repeat. Enforced here rather than by tightening rule 3's wording because the model reasoned its way around the words, and #335's arms already showed prompt text is the weak lever for this class.

Compaction report round (#280, always on since 2026-09-15; `REIKA_COMPACTION_REPORT=0` restores the ledger-only recap for a baseline arm — `agent/compactionreport.ts`, the call in `runTurn` just before `compactHistory`, the note threaded through `buildRecap`). The recap a fold leaves is a ledger of reads with none of what was found in them; the model's conclusions live in reasoning, which the fold drops. On the #335 A/B the un-delegated arm had every file the answer needed by round 6, then folded five times and re-read them after each fold ("Approval.tsx? Not yet" — read at round 8), 3h01m, no answer; the delegated arm's subagent was forced to write its findings at its cap (#344) and the parent answered 7/7 from that digest. Same model, same files: one path was asked for its findings before they were dropped. This is that ask on the parent path. When a fold is due, one extra `callModel` — the round's own tools with `tool_choice: 'none'`, `buildCompactionReportDirective(n)` last in the suffix (or the tail note under PREFIX_STABLE), the UNFOLDED history — returns the note; it is clamped (`COMPACTION_NOTE_MAX_CHARS`), committed to the UI as an info notice (never to history as an assistant message — the note-writing reasoning must not carry over), and passed to `compactHistory` as `CompactionNote {n, text}`. `buildRecap` leads with it under `compactionNoteHeader(n)` — the header says the words are the model's own, because a note under a tool-output header would be re-verified as second-hand, the exact re-read it exists to prevent — fitted from the FRONT (`fitNote`; `fitEntry` keeps the newest rounds, wrong for a note), at `NOTE_SHARE` of the recap budget with the read ledger under the remainder. A note supersedes the prior fold's narrative (the model saw it when writing the new one and is told to carry forward what still matters), so recaps never stack (#275). `n` is `shrink.folds + 1`, session-cumulative via `priorShrink`. The round is gated on the fold actually removing something: under PREFIX_STABLE the batch-age shed often gets the request under the threshold and the fold then keeps everything — the first run wrote two notes into `removed=0` and the counter never moved. **The note is written BEFORE the shed** (#426): written after it, the note request paid the shed's mid-history rewrite and the real request paid the fold's — two full re-prefills in one event (measured at the first live fold after #428: 9k + 9.3k tokens, 416s + 431s on a 24k window) — where pre-shed it is a pure append on the previous round (`phase=report cause=trailing-note`/`append-only`) and the shed and fold land together on the real request, which the fold was going to diverge from the top anyway. It is also written from the live bytes the shed is about to collapse rather than their outlines, which is what a findings note is for. The gate is therefore `foldAfterShed` (`compaction.ts`): the loop's own decision replayed on a shallow copy — run the shed, then "still over the low watermark and the fold-point walk keeps something" — since `shouldCompact || agedButAboveWatermark` reduces to exactly that once the event fires; off prefix-stable there is no shed and `wouldFold` on the history is the decision itself. The note request passes `stampRenders: false`: pre-shed the fit-to-window cap has the least room of the whole event, so bytes frozen there would be the most truncated ones and the real request would reuse them; left unstamped, the real request renders the fresh payloads with the post-fold room — free for the cache, since that request already diverges before the fresh block. UI: a top-level info notice announces the note (so the nested block reads as deliberate), `onCompactionNote` nests the live stream like a subagent's with the info accent on the reasoning bar (`streamingBar`) and a "Writing compaction note" spinner, and the note commits as a nested assistant message marked `compactionNote` — markdown-rendered, WITH its reasoning kept as a trace of how the note was derived (UI-only; the model's history gets only the note via the recap). The fold notice closes the block. Agent mode only for now — plan mode has its own force-write and transform. An empty content channel gets ONE retry with `COMPACTION_REPORT_RETRY` (observed on a third fold at 91% context: the model emitted an in-band tool call instead of the note; the reasoning fallback caught a thinking stream ending in "let me search…" — prose, no file:line, no open list); failing both, the first reply's reasoning is the fallback. The `compaction-report` debug line carries `finish=… content=…c reasoning=…c inband=N` so an empty note is diagnosable. Fail-open: an empty or aborted reply folds exactly as before. Cost: one generation per fold; the report round's prefill is append-only on a context the fold is about to reprocess anyway — **now that it keeps the tools** (#426). It first shipped with `tools: []`, and a chat template renders the tool list into the system turn (Qwen3.8's puts it BEFORE the system prompt: rendered with and without tools, the two prompts share 228 bytes), so the note round re-prefilled the entire request (~7–11k tokens on the measured 24k runs, 6–9 min at 20 tok/s) immediately before the fold re-prefilled it again — and the `prefix-cache` log never showed it, because the trace compared messages only and the note round had no line of its own. `tool_choice: 'none'` keeps the rendered prompt byte-identical and forbids the call at the sampler instead (llama.cpp renders the template with the tools regardless of `tool_choice`, and only the grammar is gated on it); the same field carries the subagent's report round. `client.ts` degrades from a backend that rejects the field the way it does for logprobs: one retry in the old no-tools shape, latched for the session. Flag off, every request is byte-identical.

Subagent pressure affordance (#343, on by default since 2026-09-19; `REIKA_SUBAGENT_PRESSURE=0` is the baseline arm — `agent/subagentpressure.ts`, hooked in `runTurn` right after a `grep`/`glob` result). The mid-session subagent trigger, harness-driven. The routing rule (#335) handles a request that arrives trace-shaped; mid-session the model has an observation it never has at round 0 — "N files match" — and #335's forecast-shaped arm got 0/2 while #280's run 3 had the model delegating unprompted the moment a harness line said "the context is about to be compacted". So the signal goes in the tool output at the moment of decision (the #102 move): when `filesInResult` ≥ `PRESSURE_MIN_FILES` (4, the tool description's own trigger) and `underPressure` — the round's calibrated estimate plus up to `PRESSURE_READ_HORIZON` reads at `READ_COST_TOKENS` crosses `compactThreshold` — the payload gets `buildSubagentAffordance` as a footer, where the spill and cap footers live (capPayload keeps head and tail, so it survives the cap). Once per turn; gated on `subagent` being in the tool list, which keeps it out of subagents and plan mode, and on a known context window — without one there is no threshold to measure against, so a windowless session never sees it. Pressure-gated because a spawn evicts the parent's KV prefix on one slot: below the threshold a pure loss, at the threshold the same one reprocess a shed would cost, and it prevents the shed. Default-on is a cost argument, not a measured win: the one live run had it fire at round 1, be heard ("given context pressure, maybe a subagent…") and be declined for trust ("I should read the main files myself"), so uptake is 0/1 and the barrier is perceived report precision, not the trigger; the default buys the trigger for one ~330-char footer that ages with its payload, on sessions that already run at the threshold. `REIKA_SUBAGENT_NUDGE` stays off and commented out in `.env.example`: round-0 routing on shape measured over-eager and lost the A/B to the compaction note alone.

URL grounding (`REIKA_URL_GROUNDING=1`, default off, experimental) is the same harness-drives-the-tool move applied to links. A local model sometimes writes a plausible-but-wrong URL into code or a comment — an API endpoint, a docs link, a `fetch()` target — and unlike a hallucinated symbol (caught by typecheck / the plan check above) a bad URL fails silently and only breaks at runtime. So rather than waiting for the model to _choose_ to call `fetch_url`, `tools/_urls.ts` scans the text a write/edit introduces, fetches any http(s) URL on the model's behalf (via `extractUrl`, the shared helper lifted out of the `fetch_url` tool), and appends a note beside the dep-surface block: a ✓ with a short snippet confirms the real page, a ✗ flags a link that does not resolve as "fix this, don't assume it works." Mirrors `tools/_deps.ts` exactly — capped (2 URLs/call), per-turn deduped (`ctx.groundedUrls`, like `resolvedDeps`), fetches run in parallel so wall-clock is one timeout. Two eligibility rules keep it from grounding fixtures: a **dotless host** (`http://vision:8081/v1`) is skipped before the cap, since it cannot be public and its DNS miss would otherwise write "the network may be down" into the model's context on an online machine (observed once per turn for three turns on one test host — the only thing the grounder did in 94 saved sessions was 2 ✓ and 5 of these); and an edit to a **test or fixture path** (`isFixturePath`, groundcheck's `TEST_FILE` anchored for project-relative paths) is skipped whole, because a URL there is a fixture by construction. The point is determinism: the grounded fact arrives in context whether or not the model would have looked it up. Unlike the dep grounder (a silent local read) a URL fetch has external side effects and latency, so it isn't invisible: the grounder returns a user-facing receipt on its result (`ToolResult.notice` for the edit/write path; the `UrlGroundingOutcome.notice` the loop captures for the plan path), and the loop renders it as a standalone `system` scrollback line _after_ the action it describes — `info`/"all reachable" on success, `warn` naming the dead link on failure. Placement matters: the receipt is emitted after the tool chip (or after the plan message), not from inside the tool mid-run, so it reads as a follow-on rather than being stuffed in front of the edit. (This is why grounders return the notice instead of emitting it — tools return data, the loop owns rendering.) It also runs at **plan commit** (`groundUrlsForPlan`, wired beside the symbol/path `groundcheck` at `loop.ts`): a plan can recommend a URL that never reaches a write — a plan-only workflow, or a docs link in prose — which the edit/write hook would never see, so the plan path fetches the URLs the plan names and appends a flag-only note (dead links called out, not snippets — that's `buildPlanUrlNote`, mirroring the symbol advisory) inherited verbatim by the agent turn. Both paths share one core (`groundCandidates`: flag gate, per-turn dedupe, parallel fetch) and differ only in how they render the results into a note. Offline-safe by construction: `extractUrl` distinguishes a server that answered with an error (`reached: true` — a real 4xx/5xx dead link) from a request that got no response at all (`reached: false` — DNS failure, refused, timeout, or no internet). A no-response URL is only called dead when something else in the same batch _did_ reach a server (`batchOnline` — proof of connectivity); with no such proof it's `unverified`, not flagged — so a plan/edit written on an offline machine isn't stamped with phantom "invented URL" warnings (the receipt says "couldn't verify", `info` not `warn`). Same experimental discipline; keep the helpers together and clearly marked.

Read-only bash in plan mode (#109, on by default since 2026-09-18; `REIKA_PLAN_BASH=0` is the baseline arm — `tools/_readonly.ts`) gives plan/vibe the inspection a pipeline expresses and the dedicated tools cannot — `grep … | head -20`, `find`, `wc -l`. `readOnlyBashTool` (`tools/bash.ts`) spreads the ordinary `bash` tool, keeps `name: 'bash'` (no second dialect for the model to learn, and plan-progress command matching still keys on it), and admits a call only when `isProvablyReadOnly` can PROVE the command read-only — otherwise returning an ordinary result naming the rule and the way out, never an error, because a small model recovers from a stated rule far better than from a tool that silently isn't there. The refusal states the rule but NOT the allowlist: that already rides every request in the tool description, and a refused model retries, so restating it per refusal would re-teach what the model can already see (cf. `WITHDRAWAL_DIRECTIVE`, which carries no content for the same reason). The run delegates to `bashTool.run`, so spill and timeout behave identically; plan mode's guarantee is unchanged in kind (it still cannot mutate the repo) but is now enforced by a classifier rather than by the tool's absence, which is why it keeps its own switch apart from plan mode itself. It went default-on because plan mode is agent mode minus mutation, and the classifier — not the tool's absence — is what carries that guarantee.

It does **not** prompt for approval. `off` is documented as "confirm every _mutating_ action" (`types.ts` `AutoApproveMode`) and the classifier has just proved the command mutates nothing, while plan mode's other four tools read arbitrary paths with no prompt at all — so gating this one behind a modal would ask the user to authorize a capability `read` already has, and would train them to approve bash modals reflexively, weakening the prompt in agent mode where it carries the real decision. The command still renders its chip in scrollback, so nothing runs unseen. The exemption is scoped to the proven-read-only tool; `bashTool` itself prompts exactly as before, and both halves are asserted in `bash.test.ts`.

`tools/_readonly.ts` answers **two questions, not one**, because its callers want opposite things. `isProvablyReadOnly` gates plan mode: `true` ADMITS the command, so a wrong `true` is a write that escaped the guarantee and it must UNDER-allow. `isInspectionEscape` drives the loop's withdrawal ladder: `true` REFUSES the call as the bash-shaped escape a withdrawn model routes to, where a wrong `false` lets the model keep circling (the failure the subsystem exists to break) and a wrong `true` refuses a real build mid-loop. `sed -n '1,50p' f` is the case that proves they differ — a line-range read the ladder MUST catch and plan mode must NOT admit, since its program argument can write and no regex can rule that out. Collapsing them into one predicate silently costs whichever caller is on the losing side; the first cut of #109 did exactly that and dropped `sed`/`awk`/`tree` from the ladder. They share every rule and differ only in which command names they recognize.

Both are permission boundaries, so they are an allowlist of command names plus an explicit enumeration of what an allowlist cannot see: command substitution (`$(…)`, backticks, process substitution — tested against the raw string, since `$(…)` executes inside double quotes), redirection (tested against a quote-mask, since `>` is routinely search _data_), every separator that starts a new command (`;`, `&`, `|`, newline — a missed one lets a second command ride along), and the recognized commands that can still be asked to write (`find`'s exec/write flags, `sort -o`, `uniq`'s second operand, `sed -i` and `tree -o` for the ladder — enumerated per command because the same spelling reads elsewhere: `grep -o` is only-matching). `awk`/`sed`/`tree` are deliberately outside plan mode's set: the first two take a Turing-complete program as an argument that can write (`awk '{print > "f"}'`) or shell out from inside the quotes, and validating that by regex is a losing game. Every enumerated rule has a test in `_readonly.test.ts` — a wrong `true` there is a write plan mode admitted, so the prose does not stand on its own — and `loop.planbash.ladder.test.ts` pins the ladder's half through real dispatch, since swapping the wiring back to the strict predicate leaves every classifier test green while reopening the escape. `buildPlanPrompt` reads the same flag: a prompt that says commands "will fail" while `bash` sits in the tool list is worse than saying nothing, and `prompt.test.ts` asserts the two stay in step.

One consequence worth naming: the plan ledger (`buildPlanLedger`) and the handoff digest (`buildHandoffDigest`) index exploration by `path`/`pattern`, and a `bash` call carries `command` instead. Both now read `command` too. Without it the mode's convergence machinery goes blind exactly when the flag is on — the ledger would report "Nothing examined yet" to a model that had just read half the repo through `cat`, the round-1/2 stop-exploring nudge (which keys on having examined something) would never fire, and the digest the agent turn inherits would under-report the plan phase.

Mode switches are blocked while `status === 'busy'` to avoid mid-turn state corruption.

When adding new modes, follow the same pattern: decide which existing side it shares with (or define its own stash slot) and update the swap logic in `switchMode()`.

## Approval gate

Mutating tools (`edit`, `write`, `bash`) MUST honor `ctx.requestApproval` if present. When it returns `false`, the tool MUST exit without performing its action and emit a clear summary like `"Edit declined by user for X"`. The `ApprovalRequest` object also accepts optional `warnings` — for `bash`, dangerous patterns trigger warnings that bypass session-auto-approve.

`warnings` is not decoration: it is the _only_ thing that makes an approval survive session-auto-approve (`hasWarnings`, `App.tsx`), so a tool that never sets it can never prompt under `safe`. `write` and `edit` set it for a path that resolves outside the project (`escapesProject`, `tools/_paths.ts`) — until then neither passed one, so under `safe` every write auto-approved to any path `resolveUserPath` would produce, `~/.zshrc` included, and there was no setting at which the modal fired. Under `bypass` there is no modal to fall through to, so an out-of-project write is refused outright, before the file is touched or even read, with the boundary named in the summary. For `edit` the prompt comes before the `readFile`, not just before the write: every match-failure branch returns ahead of the diff approval and is built from file contents (`fuzzy.hint` names lines, `editFailure.excerpt` carries up to 40 verbatim), so gating only the write left `edit` usable as a read primitive for any path on disk — an `old_string` that cannot match returned the file. Its preview is built from the model's own arguments so it needs nothing off disk, and the later diff approval no longer re-raises the warning, which keeps `safe` at a single modal. `write` is the same shape for a cheaper reason: approval precedes the `stat` whose "already exists" answer the model reads back. Both tools carry two names for the target — `display` (resolved, user- and model-facing) and `rel` (project-relative, and the only one that may reach `diff.path`, since `App.tsx` hands that to `ignore`, which throws on an absolute path). The check is a string comparison, not containment — a symlink inside cwd pointing outward passes it — which is the right trade for a confused model and explicitly not a defense against a determined one; kernel-enforced confinement is #163. Four families live in `bash.ts`: destructive commands (`DANGER_PATTERNS`), workflow policy (`POLICY_PATTERNS` — commit/push/publish), **package management at any scope** (`PACKAGE_PATTERNS` — installs, uninstalls, and registry-fetch-and-run like `npx`/`dlx`/`uvx`), and verb-position commands (`VERB_PATTERNS` — `curl`/`wget` network egress, `pkill`/`killall` kill-by-name). Installs are gated regardless of scope because every ecosystem executes install-time scripts, and a small model routinely reaches for a hallucinated or typosquatted package name; even a bare `npm install` builds from a manifest the model may have just edited, and `npx some-cli` is the same vector without the install. Behind the enumerated managers sits `genericPackageLabel` — a shape rule (verb position is `install`/`uninstall`, matched per shell segment, read-only leads like `grep`/`man`/`git` skipped so an `install` _argument_ never trips it) that catches the long tail (conda, mix, `make install`). It reports only when no specific package pattern fired, so `pip install` shows one precise label rather than two overlapping ones. `VERB_PATTERNS` matches per shell segment too, and only in the verb position (after `VERB_PREFIX_RE` strips env assignments, `sudo`/`nohup`/`time`, and segment-opening keywords; segments split on command substitution as well as the operators), because `curl` and `pkill` are ordinary _arguments_ in `grep -rn curl src/` — blanket matching would fire on reads and erode the signal. `curl … | bash` deliberately reports both its pipe-to-shell label and the fetch itself.

If the tool produces a diff (e.g., `edit`, `write`), include it on the `ToolResult` via `diff: { text, path, added, removed }`. The loop attaches it to the tool message, and `Scrollback` renders the diff under the summary via `DiffView` so the user can see what was actually applied. The diff text uses the `+ `/`- `/`  ` line-prefix format produced by `buildEditDiff` / `buildWriteDiff`.

If the tool ran a shell command (e.g., `bash`), include `command: { text, outputTail, outputTruncated }` on the result. The loop attaches it to the tool message; `Scrollback` renders the command as a `$ <command>` line followed by the last ~10 lines / 2KB of the run's **end** (preceded by an "earlier output omitted" marker when anything came before). Used so the user can reconstruct what auto-approved bash calls actually executed and produced.

**A shell edit gets the edit tool's diff (#278).** `bash` brackets every run with `tools/_treediff.ts`: `snapshotTree` before, `changesSince` after, and any file whose bytes differ rides the result as `changes: { files, more }`, which `Scrollback` draws under the command chip — one path line with an edit-style stat tag (`changeLabel`, `ui/format.ts`), then each hunk through the same `DiffView`. Git is the detector, not the command text: parsing a command for its write targets loses to `npm run fix` or a heredoc piped into python, and git already holds the previous bytes of every clean file (`cat-file --filters <old head>:path`). So the snapshot only keeps the files git already reports dirty — the one set whose previous bytes live nowhere else — plus the commit HEAD is on, and a pre-dirty file diffs against the snapshot, not HEAD, so a `git commit` of an existing edit shows nothing. **A command that moves HEAD gets the same diff (#337):** a `git checkout`/`merge`/`reset`/`pull`, or an edit committed in the same call, leaves the tree clean against the _new_ head, so status lists nothing — `changesSince` compares the two heads and adds `git diff --name-status old new` to the candidates, with previous bytes read from the old commit; a dirty file the switch carried over unchanged is not reported, since it still diffs against the snapshot. Renames are left undetected on purpose (the old path vanished and the new one appeared, which is what the tree did). Ignored files are absent by the same rule the file index applies. **Outside a repo the fallback is the command text after all** (`tools/_writetargets.ts`): deterministic and a best shot — it snapshots the files the command names (redirect targets, `sed -i`/`perl -i` operands, `tee`, `rm`, `touch`, the `cp`/`mv` destination; heredoc bodies stripped, quoted `>` left as data, leading `cd` hops applied) and diffs exactly those, so a heredoc or `sed -i` edit shows and a formatter sweep shows nothing. The narrower coverage is stated, not discovered: the first shell command in a no-repo cwd carries a `ToolResult.notice` (`info`, once per cwd) that says so — user-facing only, never in the model's context, where it could act on none of it. Bounded on purpose: 8 files drawn and the rest counted, 80 rows per file, 512KB per snapshotted file, and HEAD bytes fetched only for files that get drawn, so a formatter sweeping 200 files never costs 200 git processes. Display-only like `diff` — the model's summary and payload are byte-identical with or without it. `DiffView` grew an `oldStartLine` for this: a second hunk starts at different lines in the old and new file once the first one changed the count.

**A bash command has two bounds, and the kill reaches the whole pipeline (#408).** The ceiling (`REIKA_BASH_TIMEOUT_MS`, 30 min) is sized for real work — a slow build, a full suite — and the idle bound (`REIKA_BASH_IDLE_MS`, 5 min without output) is what catches the stuck class, because a hang goes silent: a dev server after its banner, `tail -f`, a prompt waiting on stdin. A running suite keeps writing. Idle equals the old absolute default on purpose, so anything that completed under it still does; either is `0` to disable. Both kill the **process group** (`detached: true`, `kill(-pid)`), not `sh`: for `cd x && npm run dev` the shell forks, and killing it alone left the server holding our stdout pipe, so `'close'` never fired and the "ceiling" bounded nothing (measured: `sleep 3; echo` "killed" at 100ms, resolved at 3s). SIGTERM first, SIGKILL after a short grace; a reika exit sweeps the live groups, since a group of its own is one the terminal's hangup no longer reaches. The turn's abort signal rides `ToolContext.signal` and kills the same way, so ctrl-c reaches the child instead of waiting out a bound — shell mode too, which used to set no controller at all. stdin is `/dev/null`, so a stdin reader gets EOF at once rather than the idle bound. The kill's reason is loud in both the summary and the payload (an idle kill says "do not re-run it as is"): a model that reads a killed command as a slow one re-runs it, and for a hang that never ends.

**Auto-approve modes:** `REIKA_AUTO_APPROVE` parses to one of three modes (`config.autoApprove: 'off' | 'safe' | 'bypass'`, see `parseAutoApprove` in `config.ts`). `safe` (also `true`/`1`) auto-approves ordinary actions but lets dangerous-pattern commands fall through to the prompt — the warnings break-glass short-circuits inside `requestApproval`. `bypass` (also `yolo`) skips the gate entirely (App passes `requestApproval: undefined` to `runTurn`), so nothing prompts. `off` confirms everything. **Unset is `safe`** (since 2026-09-18): the danger scan already holds back everything an in-repo `git checkout` can't undo, and confirming each ordinary edit made every multi-edit session a click-through. `config.autoApproveExplicit` records whether the var was set, because the session toggle has to tell a default `safe` from an env one: `effectiveAutoApprove` (`approval.ts`) resolves forced env → session toggle → config default, where the toggle is `null` until touched (so neither the default nor an explicit `off` is copied into React state at load), and `autoApproveForced` is true only for an explicit `safe`/`bypass` — an explicit `off` is still liftable by "Always (this session)", as it was before. The session-level toggle (`/approvals on|off`, or the "Always (this session)" choice during a prompt) sets `sessionAutoApprove`; the slash command is a no-op when env forces a mode. **`bypass` is env-only on purpose** — no `/approvals bypass`, and "Always (this session)" grants `safe`, never `bypass`. The restart is the friction: `safe` is a preference (everything it lets through is a `git checkout` away), while `bypass` is the one mode where a quantized model can `rm -rf` or install a hallucinated package with nobody in the loop, so it should be a session-start decision written down in the env rather than a one-liner typed mid-flow when the third `npx` prompt gets annoying. `warnings` piercing the session toggle is what makes that hold — there is no mid-session route to `bypass` at all, and that is a property, not a gap (same shape as Claude Code's `--dangerously-skip-permissions` and Codex's `--dangerously-bypass-approvals-and-sandbox`, both launch-only). Headless runs follow the same default, so `reika -p` edits on its own unless `REIKA_AUTO_APPROVE=off`. Status bar shows a coral `auto approve` indicator (`theme.autoApprove` — not `warning`, which the context gauge already uses on the same line) under `safe`, and a red `bypass approvals` indicator under `bypass`.

**Local sandbox (#163).** `REIKA_SANDBOX` (default on) runs model-chosen `bash` commands under Seatbelt — the system's own `sandbox-exec`, so nothing is bundled and there is no dependency that can change under us. `tools/_sandbox.ts` owns the profile, the network classifier and the two strings that describe it; `bash.ts` owns the decision (`decideSandbox`).

**The rule is one sentence: a flagged command a human just cleared runs unsandboxed; everything else runs sandboxed.** `detectDangerousPatterns` is the same signal that already decides whether to prompt, so the composition needs no second classifier for _whether_ to sandbox: the flagged-and-cleared shape is the only one that needs unbounded network and writes (`npm install`, `git push`, `curl | sh` are all in the patterns) and is exactly the one somebody looked at. That is why there is no HTTP/SOCKS5 proxy layer here, which is the ~80% of `sandbox-runtime` this deletes. "A human cleared it" is `flagged && requestApproval defined` — a flagged command forces the prompt in every mode that has one, so if the gate existed and the tool got past it, a human answered. The tool cannot tell a click from an auto-approval otherwise, which is why a **clean command confirmed under `off` still runs sandboxed**: the human saw the command's text, not what the script it runs will do, and the sandbox costs it nothing it was cleared for.

| `REIKA_AUTO_APPROVE` | clean command          | flagged command      |
| -------------------- | ---------------------- | -------------------- |
| `off`                | prompt → **sandboxed** | prompt → unsandboxed |
| `safe`               | auto → **sandboxed**   | prompt → unsandboxed |
| `bypass`             | auto → **sandboxed**   | auto → **sandboxed** |

The scan was **hoisted out of `if (ctx.requestApproval)`** to make the `bypass` row possible: under `bypass` `requestApproval` is `undefined`, so the scan never ran, and a sandbox keyed on it would have covered nothing in exactly the autonomous configuration the issue exists for. A sandbox denial is a _runtime_ failure, never a modal — `requestApproval` fires before spawn on a pattern match, the denial happens inside the child afterward — so there is no escalation flow by construction, and one is deliberately not built (a command that wrote three files and then hit a denial has already half-run).

**Network is decided per command, and the deny has two holes on purpose.** The first cut was `(deny network*)` with the model server's port allowed back through, on the premise that a flagged command is the only kind that needs the network. Measured, that premise is false for _reads_: `_danger.ts` deliberately leaves `gh pr view`, `gh issue view`, `gh pr diff`, `git fetch`/`pull`/`ls-remote` unflagged, so under default `safe` they ran sandboxed and failed — `Error connecting to api.github.com` — and the shipped `/issue` and `/review` skills broke on their first call. And `(remote ip)` alone refused `network-bind`, so any suite that starts a local server (`listen(0)` → EPERM; this repo's own `transport.test.ts`) went red, with the network footer then blaming the sandbox for the whole run. So:

- **Loopback is open wholesale, both directions, every port — but per operation, never `network*`.** `(allow network-outbound (remote ip "localhost:*"))` for connect, `(allow network-bind …)` and `(allow network-inbound …)` with `(local ip "localhost:*")` for listen/accept, all after the deny (last-match-wins). Measured: `listen(0)` plus a loopback GET succeed on `127.0.0.1` and `::1`; outbound TCP and UDP to a raw non-loopback IP get `EPERM`. The first cut wrote `(allow network* (local ip "localhost:*"))` and it **admitted every outbound connection** — an unconnected socket has no local address yet, so the filter matched — and `curl http://1.1.1.1/` returned 301 through a profile whose comment said the network was denied; the only reason `curl example.com` still failed was that DNS runs over a unix socket, which was also denied. `_sandbox.test.ts` pins that a `local` filter only ever appears on bind/inbound, and `bash.test.ts` connects to a raw IP (`192.0.2.1`, needs neither DNS nor a route) and asserts the refusal. The confused-model threat is what a command does to the machine and the network, and a loopback listener is neither. Opening loopback also means the profile needs no config at all — no `baseURL`, no per-profile port, nothing to get wrong on a `/model` switch — and it is passed inline (`-p`), so there is no file to write and a fresh machine with no `~/.config/reika` is sandboxed exactly like one that has it.
- **Unix-domain sockets are allowed** (`(remote unix)` / `(local unix)`, same per-operation shape). They are local IPC, not the network: the docker daemon, a local database, and macOS's own DNS resolver (mDNSResponder) all live there. Denied, `docker ps` failed with "permission denied while trying to connect to the Docker daemon socket … connect: operation not permitted", which reads as "use sudo / join the docker group". A consequence worth knowing: DNS now answers inside the sandbox, so an internet denial surfaces on connect() — curl and git say "Couldn't connect to server" (rc 7), node `connect EPERM`, python `[Errno 1] Operation not permitted` — rather than as an unresolved host, and `NET_DENIAL_RE` carries both families. Docker mutations (`run`, `compose up`) are flagged by `_danger.ts`, so under `safe` they still prompt; under `bypass` the daemon does what the CLI asks, which the sandbox never claimed to gate.
- **An unflagged `gh`/`git`/`glab` command keeps the network** (`networkAllowedFor`): the profile simply omits the network rules, writes stay confined. The classifier is an allowlist over the command's verbs, built on `_readonly.ts`'s segment/word helpers: every segment must be one of those three or one of the inspection commands a model pages remote output through (`gh pr diff | sed -n '1,300p'`, `| wc -l`, `| xargs -I{} gh issue view {}` — `xargs` is read through to the command it runs); any substitution (`$(…)`, backticks) or unrecognized verb (`python3 -c`, `node -e`, `npm`) denies, as do the inspection commands that can run a command of their own (`awk`'s program, `find -exec`). `git -c`/`--config-env` is refused the allow wholesale — `alias.x='!…'`, `core.sshCommand`, `core.pager`, `credential.helper`, `core.hooksPath` all name a program, and none of the fetch-shaped commands need `-c` — and an env-assignment prefix keeps it only from a short list of settings that cannot name one (`GIT_TERMINAL_PROMPT`, `GH_NO_UPDATE_NOTIFIER`, colour/locale; the pager vars only when set empty or to `cat`). Redirections are blanked before the split, because `2>&1` contains `&` and turned `gh pr view 1 2>&1 | head` into a segment whose verb was `1`; heredoc bodies are cut first (`stripHeredocs`, shared with `_writetargets.ts`), because `gh issue comment 1 --body-file - <<'EOF' …` — the standard way a model writes a multi-line comment — split its prose into segments and was denied every time. When a gh/git pipeline is denied _because of a sibling_ (`git fetch && npm test`), `networkDecision` names it and the footer says to run the git half as its own call — the model's own remedy, where "ask the user" would be the wrong one. `.git/hooks` being writable through `GITDIR` is a known remainder of this class, accepted under the confused-model threat. Their outward-facing forms (`git push`, `gh pr create|merge`, `gh release create`) are flagged, so they prompt and run unsandboxed — and under `bypass`, where a flagged command reaches the sandbox with nobody looking, **flagged never gets the allow**: `git push` there keeps the deny and the footer tells the model to ask. `gh issue comment`/`gh pr review` are unflagged and get network, which is what `main` did too; flagging them is `_danger.ts`'s call, not the sandbox's.

Five things in the profile that were each found by measuring, not by reasoning:

- **`WORKDIR` must be `realpathSync.native(cwd)`, not the cwd string.** Seatbelt matches `(subpath …)` against the path the kernel sees; `reika`'s cwd is whatever the user typed, and on macOS `/tmp` is a symlink to `/private/tmp`, so `-D WORKDIR=/tmp/proj` matches _nothing_. That failure mode is worth the paragraph: an unmatched WORKDIR means `(deny file-write*)` denies the whole filesystem, **including creating any new file inside cwd** — `mkdir -p src` fails, a heredoc can't write its target — while writes to files that already exist still succeed, so it reads as a partial, confusing failure rather than a profile bug. It silently makes the sandbox unusable, and it was caught only because `_treediff`'s tests run on a `tmpdir` cwd.
- **Temp and cache dirs are writable, by their real paths.** `mktemp -d`, `cd /tmp && …` and `tempfile` are how a model scratches, and the first cut denied them — which did worse than fail: python's `tempfile.mkdtemp()` falls through `TMPDIR` and `/tmp` to its last resort, the cwd, and silently wrote `tmpXXXX` into the project. So `/private/tmp`, `/private/var/tmp` and the realpath of `os.tmpdir()` (`/private/var/folders/…/T`, per machine, hence a `TMPDIR` param) are allowed. Caches on the same disposability argument (`USERCACHE` = `~/Library/Caches`, `XDGCACHE` = `$XDG_CACHE_HOME` or `~/.cache`): `go build` refuses to run at all without a writable `go-build` cache (measured, exit 1 for the whole session), and Gradle/Maven/Xcode have the same shape. `~/.cargo`, `~/go`, `~/.m2` are NOT allowed — registries and artifacts, not caches — and a build that needs them fails loudly with the path named; the footer says it was the sandbox and not a `sudo` problem, and a once-per-cwd `warn` receipt tells the user `REIKA_SANDBOX=0` exists (the model is never told the flag: it cannot set it). Both are keyed on the output's _shape_ (`FS_DENIAL_RE`: a path beside the message — `/bin/sh: /Users/x/f: Operation not permitted`, node's `EPERM: …, mkdir '…'`, python's `Operation not permitted: '/…'`), not on the exit status, because `mkdir ~/x; echo ok` exits 0 with the denial in its output; the ps and network notes keep the exit gate, since a red run is when they are read. Python's `[Errno 1] Operation not permitted` is the one text both a write and a connect denial print — the trailing quoted path is what tells them apart.
- **The git dir above cwd is writable.** `WORKDIR` is the cwd, but for a monorepo package (`packages/web/`), a `git worktree` (`.git` is a file pointing into `main/.git/worktrees/x`) or a submodule, `.git` lives above it — and `git add`/`stash`/`checkout`/`fetch` (writes `FETCH_HEAD`) all failed on `.git/index.lock: Operation not permitted`, an error that reads as a stale lock and whose natural next move is `rm -f .git/index.lock`. `sandboxPlan` resolves `git rev-parse --git-common-dir` once per cwd and binds it to a `GITDIR` param when it lies outside cwd (to `WORKDIR` otherwise, since an unbound param exits 65).
- **`(allow file-write* (subpath "/dev"))` is required, and must come last.** `stdio: 'ignore'` gives stdin `/dev/null`, but _shell_ redirection to it is a write: `npm test >/dev/null 2>&1` failed with `/bin/sh: /dev/null: Operation not permitted` and took the command's exit status with it. Seatbelt is last-match-wins and `/dev` is the parent of `/dev/null`, so a rule placed after it that is meant to win must be more specific than a whole directory — a sibling path is not. Getting this order wrong silently re-allows `/dev/urandom`.
- **`ps` and `top` cannot be exec'd under seatbelt at all** — measure as an unconditional failure, including under a bare `(version 1)(allow default)` profile with no denies in it (`ps` exits 126; `sandbox-exec: execvp() of '/bin/ps' failed`). #163 lists allowlisting them as an option; it is not one, and `file-write*`, `(literal …)` and an all-subsystems-allowed profile were each tried. So the affordance is the whole fix: `sandboxFooter` names `ps`/`top` explicitly, because `ps aux | grep …` is an ordinary thing to reach for and the denial reads exactly like a broken pipeline.
- **Network denial is the affordance problem.** Seatbelt's filesystem denials are excellent — uniform, and they name the path — but a network denial never says "permission": `curl` reports `Could not resolve host` (rc 6, and _nothing at all_ under `-s`), `git push` says "make sure you have the correct access rights" (SSH keys) and `npm install` says "make sure your 'proxy' config is set properly" (proxy config). Each points at a real but wrong repair, which is the classic spiral setup. So a sandboxed command that fails **and whose output carries a denial's signature** gets a deterministic footer saying it ran sandboxed, that network is denied, that the DNS/auth/proxy reading is most likely that, and that `fetch_url`/`search` are the tools for the job. **The gate is on the output, not the command's name.** The first cut gated on the name (`git`, `npm`, `go`, `cargo`, …) and fired on every red `npm test`, every `cargo test` failure and `git diff --exit-code`'s exit 1 — the exact misattribution the footer exists to prevent, and one that trains the model to blame the sandbox for a genuine failure. The signatures are the texts each client actually prints under the profile (`Could not resolve host`, `getaddrinfo ENOTFOUND`, `nodename nor servname provided`, `connect to host … port 22: Operation not permitted`, `no such host`); `curl -s` prints nothing, so it alone is caught by exit status 6/7. The `ps` note keys on the shell's own `ps: Operation not permitted` line, so `docker ps` and `grep ps` cannot trip it. A network-allowed run never gets the network note: a DNS error there is the machine's.

**Reads stay open, deliberately**, so `(allow default)` is the first line and grep/glob/list/test run with no extra allowlist entries. A blocklist of secret paths (`~/.ssh`, `~/.aws`, `**/.env` — #163 phase 5) is **not built**: it is incomplete by construction, and the alternative — an enumeration of `/System`, `/usr`, `node_modules`, and every toolchain's cache directory — breaks quietly as the machine changes. The honest consequence is that at a broad cwd (`$HOME`, `/Volumes/…`) `~/.ssh` stays _readable_, so a broad cwd is **sandboxed and said** rather than refused: the two halves of the profile degrade independently, and `(deny network*)` has nothing to do with `WORKDIR`. The one case that is genuinely void is the filesystem root, where `(subpath "/")` voids the filesystem half entirely and starting silently would claim a protection that does not exist — that refuses up front. Containment against a confused model, not confidentiality against a determined one: the same threat-model line `_paths.ts` draws, and the footer says so.

**The receipt is once per cwd** (`sandboxNoticed` in `bash.ts`, the no-repo notice's shape, marked shown only when a run completes with it — an aborted first command or an exit-65 retry must not consume it): the confinement is a property of the session, and a line under every chip repeating the command the chip already shows doubled the scrollback. A human-approved command running unsandboxed needs no line — the modal was the line. The model's copy is the one sentence in the agent prompt, and it is **gated the way `canAsk` is** (`promptGates` in `loop.ts`, shared by `runTurn` and `buildRoundZeroPrefix` so the warm prefix cannot diverge): present only when `config.sandbox` is on, `sandbox-exec` works and `bash` is in the list — on Linux or under `REIKA_SANDBOX=0` it would tell the model a genuine connection failure "may be the sandbox" — and it names `fetch_url`/`search` only when the turn offers them, since minimal mode and an offline session have neither (#377).

**Fail-open, and the two places it isn't free.** `sandboxPlan` returns a _reason_ instead of argv whenever the sandbox cannot be built (an unavailable binary, a root cwd, a cwd that no longer resolves), and the run proceeds unsandboxed with a `warn` receipt on macOS, once per cwd. The one case that does not degrade is a malformed profile: `sandbox-exec` exits **65 without running the command**, so the sandbox fails _closed_ and one bug in the generator would turn every command into an uninterpretable failure. Detected on `rc === 65` plus the `sandbox-exec:` stderr prefix, then retried unsandboxed exactly once — with a `warn` on the result, because a command that ran unconfined after the sandbox refused to load is the one event here the user must see. Exit codes, SIGTERM to the process group, streaming, the two timeout bounds and subagent inheritance all pass through unchanged — a sandboxed command is the same `/bin/sh -c` one level down behind `sandbox-exec`.

**Plan mode's read-only bash is sandboxed too**, with nothing flagged and no prompt (`decideSandbox(command, [], ctx)`): `isProvablyReadOnly` is the guarantee plan mode makes, and the kernel backing it costs nothing.

**Reads/egress in-process tools are not covered, and that is the right line.** `write`/`edit` are Node, with no child to wrap; their gate is `warnings` + `escapesProject` above. `fetch_url`, `search` and URL grounding are `fetch()`, split out to #164. reika's own `execFile` calls (`identity.ts`, `pr.ts`, `clipboard.ts`, `ocr/system.ts`) stay unsandboxed on purpose — harness-driven rather than model-chosen. And nothing announces the sandbox to the model by default, so the agent prompt carries one line: what it cannot do, and to route to `fetch_url`/`search` rather than misreading a DNS error.

**Linux is a real second project.** bubblewrap has no port-level network filtering — `--unshare-net` is all-or-nothing and gives the container its own loopback, so a sandboxed process **cannot reach the host's `127.0.0.1:11434`** — which is exactly why `sandbox-runtime` needs the proxy. Following the OCR precedent (`ocr/system.ts`), macOS ships, elsewhere reports unavailable and behaves as today. Testing instrument: unit-test the profile _generator's string output_ (order, params, no interpolation), the network classifier and the footer's gating, never the syscall as such; the darwin-only tests in `bash.test.ts`/`loop.sandbox.test.ts` drive the real `sandbox-exec` for the three enforcement facts (a write outside cwd is refused, a loopback bind works, a sandboxed `curl` gets the footer) and `it.skipIf` off macOS.

## Post-edit typecheck gate

`src/check/typecheck.ts` runs `tsc --noEmit` after a turn's edits so a weak model doesn't have to remember to verify its own work. It's a **baseline delta**: a pre-edit baseline is captured at the turn's first mutating tool call, the final state is diffed against it (keyed on file + code + message, _not_ line/col, so an edit shifting line numbers doesn't flag pre-existing errors), and only errors the edit _introduced_ are surfaced. On introduced errors the model is sent back to fix them, bounded by `MAX_TYPECHECK_GATE_ROUNDS`; past the cap it finishes dirty with a user notice. TS/JS only — the one ecosystem with a cheap incremental whole-program checker on hand.

**Everything fails open.** No tsconfig, no local `tsc`, a timeout, or a crashed process all resolve to `{ ran: false }`, which disables the gate for that turn — never an error that blocks the loop. The `reason` is REIKA_DEBUG-only; it never reaches the model or the user (so a silently-dead checker can't masquerade as a green check in the logs, but also never nags).

**tsconfig resolution** (`detectTsProject(cwd, fromPath?)`), three fail-open layers: (1) `REIKA_TSCONFIG` env override — explicit escape hatch for layouts auto-detection can't reason about, like references-only solution roots or named-variant-only projects (`tsconfig.web.json`, …) with no plain `tsconfig.json`; honored when it resolves to a real file, a stale value falls through rather than going silent. (2) Walk _up_ from the edited file to the nearest ancestor `tsconfig.json`, bounded at cwd — mirrors tsc's own resolution, so a monorepo edit under `packages/web/` is checked against that package's config even when reika runs at a root with no tsconfig. (3) Degrades to `cwd/tsconfig.json` when there's no `fromPath` or nothing is found. The loop resolves this once (from the first edited file) and pins it for both baseline and final so they diff the same config. Anchoring on the edited file — not globbing config names, not crawling down from root — is what gives "which config?" a single answer; globbing risks pointing `tsc` at a base/partial config that checks nothing and returns a false green, which is worse than not running.

## Loop breaking & spiral handling

Weak/quantized local models loop in two distinct places — repeating **tool calls** and repeating **reasoning** — and the harness has a layered, mostly-experimental response to each. It's all model-invisible instrumentation plus escalating intervention; the hard ceilings (`maxTurns` round cap, the generation backstop) sit under everything and guarantee termination regardless. The detectors only change _what state it stops in_ (a grounded plan / a landed edit / an honest "what's blocking me") versus stopping blindly at a wall.

**Read/tool loops (always on).** `ReadTrace` (`agent/readtrace.ts`) classifies each read as unique / changed / dup-live / dup-aged (REIKA*DEBUG `read-trace` lines). `flagRepeatedCall` (`loop.ts`) appends a soft redirect to a repeated tracked call's payload (read/grep/list/glob/bash). A \_confirmed* loop (recency-gated; dup-live ≥2, dup-aged ≥3) raises a persistent stop directive in the non-aging system suffix via `buildAgentLoopLedger`; if it persists past `LOOP_WITHDRAW_AFTER`, the inspection tools are dropped from the offered set **and refused at dispatch** (an in-band caller routes around a merely-omitted tool, so withdrawal must be enforced where calls are dispatched, not just where they're offered). The region key is `(path, offset)`, which is blind to a model re-reading one file at a dozen _different_ start lines — every slice `unique`/`narrowed`, repeats=1, ladder never engages (a subagent read `types.ts` in 14 slices; the #335 baseline read `_danger.ts` 7× and `bash.ts` 6× across five folds). `ReadTrace` therefore also tracks **coverage depth** per file (#341, `FILE_OVERLAP_DEPTH = 4`): how many times any one line of an unchanged file has been fetched. Not a read count (flags honest paging of a big file) and not an overlap count (the first version: a 244-line read was capped, the model tiled it in four 60-line chunks that arrived whole — the omission marker's own remedy — and inspection was withdrawn on a model recovering correctly). Tiling under a capped read fetches each line two or three times; the spiral fetches the same lines four, five, eight times. A `narrowed` read is recorded but never deepens (the sanctioned descent, bounded per region by `MAX_NARROWINGS`; #184's 300→70→35→18 would be depth 4 by construction). A changed hash resets the file; at the depth the file joins `loopingReads` as a bare path (deferring to a region entry that already names it) and rides the same ledger → withdrawal ladder. Deliberately conservative — the #335 baseline's `bash.ts` sequence sits at depth 3 because its fourth fetch is a narrowing — since a false positive costs inspection withdrawn on a legitimate recovery, and the compaction note (#280) now covers the slow case. `overlapped=N` on the `read-trace-summary` line.

**Reasoning loops (`REIKA_REASONING_LOOP=1`, experimental).** `reasoningtrace.ts` measures, over word-level 8-grams, `selfRepeatRatio` (repetition _within_ one block) and `crossRoundSimilarity` (Jaccard _between_ rounds). `ReasoningTrace` tracks the cross-round streak; sustained similarity (≥0.6 for ≥2 rounds) is _rumination_ — the model re-deriving the same analysis while the tool results look new, which the novelty proxy (`planStaleRounds`) is structurally blind to. Two refinements keep this robust to paraphrase-and-oscillate spirals (which dip below 0.6 on a reworded round and would zero a hard streak) without lowering the 8-gram base rate that makes it model-agnostic: each round is compared against a small **window** of the last few rounds (max Jaccard, not just the immediate prior), catching an echo two or three rounds back; and the streak is **leaky** — a still-overlapping round (≥ half the threshold) _holds_ the streak rather than resetting it, so one paraphrased dip can't erase a real loop (holding never _builds_ a streak, so the bar to fire is unchanged). **Channel fallback:** `reasoning` is empty every round on a model with no thinking channel (or one whose reasoning the dialect handling strips — the provider only ever reads the native `reasoning_content` field), which resets the streak forever and left those models with no Layer-2 coverage at all. `ReasoningTrace` therefore falls back to the **content** channel when reasoning never appears. The channel is chosen on the first round carrying text and is **sticky for the turn** (reported as `ch=` on the debug line): a Jaccard between one round's reasoning and another's content compares two different distributions and means nothing, so the window holds one channel's shingles only, and reasoning arriving late clears a content-seeded window rather than carrying a cross-channel verdict forward. Reasoning always wins when present, so thinking models are unchanged. The 8-gram width is what keeps the content channel safe from legitimate mechanical work: a per-file round differing only in the filename measures ~0.33 against the 0.6 threshold, since every shingle spanning the varying word is invalidated. Detection always runs (feeds the REIKA_DEBUG `reasoning-loop` line); the **action** is flag-gated: plan mode gains a third force-write trigger, agent mode drives the same ledger→withdrawal ladder as a read loop.

**Withdrawal asymmetry** (`shouldWithdrawInspection`): a read loop keeps the **edit-recovery exemption** — no withdrawal once editing has begun, because a post-edit re-read is usually re-fetching exact bytes to rebuild `old_string`, not gratuitous looping. A reasoning loop withdraws even post-edit (high crossSim while re-reading is rumination, not recovery) — EXCEPT during edit-recovery itself (an unresolved failed edit genuinely needs reading). The **edit-recovery dead-end** — a reasoning loop on top of a failed edit — splits on the structured failure the edit tool returns (`ToolResult.editFailure`, computed from the same divergence its hint string already reports). A **`diverged`** failure (the anchor block exists, one line differs) is mechanically recoverable, so it gets ONE grounded round first: `buildEditRecoveryLedger` lifts the exact divergence plus the verbatim current bytes into the non-aging system suffix and asks for a single character-for-character fix — the tool's own hint rides in the tool _result_, which ages out under compaction before a period-≥2 loop returns to it, the same reason the loop ledger lives in the regenerated suffix. An **`absent`** failure (`old_string` in no file, typically a plan referencing code that doesn't exist) can't be conjured by re-reading, so it stops immediately. Both bounded like the length/typecheck caps; the grounded round is one-shot (`editRecoveryGroundingTried`) so a still-looping turn falls through to the report next round.

**Agent-mode terminal stop** (`commitAgentLoopStop`, the agent analogue of plan's `commitSpiralStop`): withdrawal pulls read/grep/glob/list AND refuses read-only bash (`grep`/`cat`/`tail`/… classified by `isReadOnlyShell` at dispatch; mutating/build bash still runs, so real work is unaffected) — this closes the escape where a model in a _post-completion verification spiral_ routed around the omitted tools by running `bash grep` with byte-identical reasoning. Withdrawal still can't gate a loop that spirals on `edit` or on mutating bash, so once a confirmed reasoning loop has been through the ledger + withdrawal and still persists `LOOP_TERMINAL_AFTER` rounds (3 — the floor: ledger=1 and withdrawal=2 each get one round, since both genuinely recover _other_ loop types, then terminal at 3; can't go to 2 without skipping the withdrawn call), the turn ends honestly — "made changes to X, edits saved, review them" if it edited, else a stuck-without-progress stop. Self-correcting: heeding either step resets the counter, so terminal only fires on a loop that ignored both. No separate "steer to finish" guard is added on purpose: the withdrawn ledger already says "if complete, say so and stop"; this stuck class ignores it (can't act on directives), and a forced wrap-up call would just re-spiral (it's structurally the force-write) — the terminal writes the completion the model couldn't. This is a third spiral _shape_: can't-find (→ withdrawal forces act/declare), can't-edit (→ edit-recovery dead-end report), and can't-stop (post-completion → terminal report).

**Logit recovery — last resort before the terminal stop** (`REIKA_LOGIT_RECOVERY=1`, experimental; only does anything when reasoning-loop detection is also on, since it fires at that terminal). Before `commitAgentLoopStop`, spend ONE biased round: `logitrecovery.ts` mines the loop's recurring 8-grams (`ReasoningTrace.repeatedShingles`, the intersection it already computes for the Jaccard), tokenizes the top ~12 distinctive words' **entry tokens**, and sends a mild one-shot `logit_bias` (−4, capped at 24 ids, tool-name tokens exempted) to gently down-weight the model's own rut without banning anything. Two things make this safe rather than reckless: it fires at a site that is **structurally pure rumination** (an unresolved failed edit would have stopped/grounded at the earlier edit-recovery dead-end, so the repeated tokens here are filler, not the work — the loop-tokens-≡-work-tokens trap that makes `logit_bias` dangerous on edit loops doesn't apply); and its failure mode collapses to the honest stop — if the biased round still loops, the turn ends exactly as it would have, never as a confident wrong action. The bias is mild + one-shot + capped + tool-exempt precisely so a failed nudge degrades to a no-op, not pollution. **Channel-exempt too** (`biasableShingles`): that whole safety argument rests on the repeated k-grams being filler, which holds for the reasoning channel only — when `ReasoningTrace` has fallen back to the **content** channel the recurring grams ARE the emitted answer, so the trap applies and no bias is built. Both hosts already fail open on an empty span, so the exemption needs no new branch at either site.

**Plan-mode host — the force-write.** The same one-shot bias also rides plan mode's loop recovery, which isn't a pre-stop round but the **force-write itself** (plan mode's recovery for both a Layer-1 verbatim abort and Layer-2 rumination). It's gated to a LOOP-triggered force-write (`planForceWriteLoopTriggered`) — NEVER the novelty-stall / ceiling convergence, where the model is finishing normally and a bias would only pollute a healthy plan. Two differences from the agent terminal: the bias is **milder** (`PLAN_LOGIT_BIAS = −3`) because this round writes the deliverable, so a polluted-but-not-spiraling _plan_ would ship (where the agent round's pollution only collapses to a stop); and a **null bias just proceeds** with the unbiased force-write — the force-write is the real recovery, the bias is an enhancement — rather than stopping. Token source splits by trigger: cross-round `repeatedShingles` for a reasoning-loop force-write; the **intra-block span** (`repeatedSelfShingles`, the Layer-1 analogue, captured from the degenerate block at verbatim-abort _before_ it's discarded and stashed for the next round) for the verbatim-abort case. This is the path that actually fires on the common single-giant-block spiral — which `verbatim-abort` catches before any cross-round terminal — so it's where the bias earns its keep on a plan-mode workload.

**Symmetry — apply a recovery to both modes' hosts.** Agent and plan mode have different loop-recovery _hosts_: agent's is the pre-stop round before `commitAgentLoopStop`, plan's is the force-write. When you add a recovery intervention (logit bias, edit re-grounding, a steer-to-act nudge), reach the equivalent round in _both_, not just the mode in front of you — the same spiral shapes occur in both, and a one-mode fix silently leaves the other to spiral. The logit recovery is the cautionary example: it shipped agent-only first and never fired on the common single-block plan-mode spiral (which `verbatim-abort` catches long before any agent terminal), so the mode where the user's spirals actually lived got nothing. Two things vary by host and must be tuned per-mode rather than copied: **output-sensitivity** — plan's force-write _is_ the deliverable, so bias milder and let a failure degrade to a no-op, where the agent round can fail to a clean stop; and **token source** — cross-round `repeatedShingles` vs the intra-block `repeatedSelfShingles`, depending on which detector triggered the recovery. The shared gate is always "a _loop-triggered_ recovery round" (`planForceWriteLoopTriggered` in plan mode, the rumination terminal in agent mode) — never a healthy convergence/finish, where intervening only pollutes good output.

**Currently llama.cpp-only, by design.** The token ids come from llama.cpp's native `/tokenize` endpoint (`transport.ts` `tokenize`, at the server root, not under `/v1`), so the recovery is **self-gating**: a backend without that endpoint (e.g. Ollama's OpenAI shim — which also silently ignores `logit_bias`) returns no ids, `buildRuminationLogitBias` yields `null`, and the turn just stops honestly. The tokenizer call is the _only_ engine-specific piece — everything else (`selectBiasWords`, `buildLogitBias`, the `logit_bias` request field) is provider-neutral. It could later be abstracted behind a tokenizer-provider interface (the same shape as `SearchProvider`) to support vllm (which also serves `/tokenize`), MLX, etc.; left concrete until a second engine actually needs it (rule-of-five — don't build the abstraction for one implementation). Same experimental discipline; keep its constants/helpers together and clearly marked.

**Converge retry — a steered last attempt before the stop** (`REIKA_CONVERGE_RETRY=1`, experimental). The honest stops (`commitSpiralStop` in plan, `commitAgentLoopStop` in agent) are the harness _giving up_ on convergence. Before that, spend ONE **steered** retry: a strong, failure-naming directive ("you looped and kept re-questioning yourself; don't overcomplicate; commit to one analysis/action and do it") instead of a cold give-up. Capped at `MAX_CONVERGE_RETRIES` (1 — one strong push; the user can retry fully after), and **worst case is unchanged** — the same stop fires once the budget is spent, we just insert a best-effort push ahead of it. Per the plan↔agent symmetry rule it lands in both hosts: plan mode re-runs the force-write with the steer appended (`buildPlanWritePrompt(steer)`) under a **tighter reasoning ceil** (`STEER_RETRY_REASONING_CEIL`) so an ignored steer is cut fast — cheap-to-fail, and the retry round stays abort-protected via `steerRetryActive`; agent mode appends `buildConvergeSteer` to the terminal round's system suffix. Motivated by a manual finding worth recording: on a plan-mode spiral, two unsteered attempts (one carrying the logit bias) gave up, and a third with exactly this steer ("do not overcomplicate … do not repeat or question yourself") converged in ~500 reasoning tokens where the others spiraled to 18k chars. The lesson generalizes the logit-recovery note: the spiral is a _behavioral_ pattern (the model re-litigating its own analysis), and a natural-language meta-instruction reaches it where token-level bias doesn't — which is why the steer runs _first_ at the agent terminal and the logit bias second. Same experimental discipline; keep its constants/helpers together and clearly marked.

**Intra-block spirals — the live signal.** `liveSpinSignal` runs the windowed `selfRepeatRatio` (12k trailing window — must exceed the repeat period; a small window misses paragraph-recycling) during streaming, debounced (~400 chars), returning `{spinning, ratio}`. The **soft hint (≥0.3, always on)** relabels the busy indicator "Thinking — may be looping (ctrl-c to abort)" and stops there — a _semantic_ spiral can't be judged mid-stream (no way to know it'll escape), so the human decides. The **automated abort** (`REIKA_VERBATIM_ABORT=1`) cuts the round's call mid-flight (on a combined `AbortController` that also forwards user ctrl-c) on either of two conditions: (a) a **length-aware ratio** (`verbatimAbortThreshold`) — 0.35 below ~healthy-max length (16k chars), scaling toward 0.25 as a single block grows (28k chars) — re-measured against 84 real blocks; the earlier 0.75/0.4 pair left a hole a _semantic_ loop walked through; the length gate makes the lower bar safe, so genuinely-long _distinct_ reasoning (low ratio) is spared — the discriminator a blunt token cap lacks; or (b) an **absolute length ceil** regardless of ratio (`REASONING_HARD_CEIL`, tighter `FORCE_WRITE_REASONING_CEIL` on the transform round) — catches a _low_-repetition semantic spiral (ratio ~0.3) the ratio curve can't see. The cut reasoning is discarded; recovery is by mode (plan → force-write from findings, agent → nudge), bounded by `MAX_VERBATIM_RECOVERIES`. **Exception (`REIKA_CONTINUE`, agent mode):** a cut on the _length ceil_ whose ratio is low is not evidence of degeneration, so it is carried forward rather than discarded — see the continuation paragraph below. Crucially the force-write _recovery_ is itself abort-protected (a deeply-stuck model spirals in the transform too): if the force-write spirals or the budget is spent, `commitSpiralStop` ends the turn with an honest "couldn't converge, files examined: …" (not `planFinal`) rather than looping or committing spiral garbage as a plan. This is the only pre-cap backstop for a single never-ending block (the round-level detectors can't run until the round completes, and the `max_tokens` wall can be ~17k+ tokens away on a near-empty context). Tune the curve/ceils against the `verbatim-abort … reason=length|ratio … ceil=` debug fields on real spirals.

**Manual abort keeps partial reasoning.** On a user ctrl-c mid-reasoning the response content is empty, so `commitAborted` would otherwise commit a bare `(aborted)` and discard the model's thinking — leaving a follow-up nudge nothing to build on, exactly when manual recovery is weakest (early turns). It now keeps the partial reasoning (capped most-recent `ABORTED_REASONING_CAP` chars) on the aborted message. (The automated verbatim abort deliberately does the opposite — discards its reasoning as spiral garbage and recovers from findings.)

**Truncation continuation — a cut-off thought is resumed, not restarted** (`agent/continuation.ts`, issue #284; default on, `REIKA_CONTINUE=0` is the baseline arm — set it for a run measuring context/eviction, since a carried tail changes what a request holds; agent mode). Generation cut off at the token limit used to discard the round and nudge a restart. The partial was in `history` the whole time and the model never saw it: the cut lands mid-think, so the text is all `reasoning`, and a Qwen-family chat template renders prior-turn `reasoning_content` as **nothing**. Measured on a real run: a 30,270-char block cut _one clause after solving its problem_ (`selfRepeatRatio` 0.014 — below the p90 of healthy blocks), after which the model re-ran the same `gh issue view` and two greps, putting identical payloads in context twice — the #251/#252 re-fetch cascade. Three parts. **The gate is the ratio, not which cut fired** (`continuationGate`, reusing `verbatimAbortThreshold`): the `max_tokens` wall and `REASONING_HARD_CEIL` landed **5.4% apart** on that run (30,270 chars against 32,000), so which one won was near-arbitrary and they cannot carry opposite semantics — a low-ratio ceiling cut now continues instead of being discarded _and_ told "your reasoning was repeating the same text", which at 0.014 was simply false. **The tail** is promoted into the `content` channel so the template renders it, cut at a paragraph boundary and marked with what was dropped; a truncated block's conclusion sits at its **end**, so a tail keeps the payoff and sheds the earlier circling by ordering alone — no classifier needed to separate them. **The ladder** bounds the burn separately from the tail: consecutive continuations without progress (a tool call or a committed answer), plus a novelty check so a continuation that merely restates the previous one stops regardless of count — both reset on progress, so there is no ceiling on how often a session may continue, only on continuing without producing anything. Two traps the tests pin, both the same shape: novelty must compare **newly generated** text (a tail contains the round it resumes, so accumulated-vs-accumulated self-triggers), and the reasoning trace must record a split thought **once** — recording each half reports the second as near-identical to the first (high `crossSim` by construction) and fires the Layer-2 breaker on the feature it protects. The carried tail is marked `continuationTail` and sheds in a pre-pass **before** either size sweep in `batchAgePayloads`: assistant `content` has no eviction branch at all, so without that the promotion would be a standing window cost only a fold could clear. The nudge carries `harness: true` — it must reach the model (so it cannot be `meta`, which is dropped from the request) but it is not a turn boundary, and without the flag it re-elects the task-spec pin (#287).

**Drift measurement — numbers, not verdicts** (`agent/entropytrace.ts`, issue #134; REIKA*DEBUG-only, `REIKA_ENTROPY=1` for the logprobs half). Every detector above emits a \_categorical* verdict (looping / not), which is what you need to intervene but not what you need to understand _where_ a model came apart. This adds the continuous quantities beside them, one `entropy round=N` line per round plus an `entropy-summary` rollup per turn. Two independent axes: **entropy** — with `REIKA_ENTROPY=1` the request carries `logprobs`/`top_logprobs` (k=5) and the line reports the engine's real predictive entropy plus the surprisal of what it actually emitted; without it (or on a backend that doesn't support it) the fallback is the empirical entropy of the round's own output, so the drift signal never depends on engine support. And **KL divergence** — `klPrev` (this round's output distribution vs the previous round) and `klBase` (vs the turn's first round), which is the axis the similarity detectors don't express: a spiral reads as `klPrev` collapsing toward 0 while `klBase` stays high (it drifted somewhere and stopped moving), and that separation is visible rounds before `crossSim` crosses a threshold. Details that matter when reading the numbers: KL is **additively smoothed** (α=0.5 over the union support) because unsmoothed KL is infinite the moment a round uses a new word — every healthy round — and the smoothing is what makes the quantity finite and comparable at all; the top-k entropy is **raw, not renormalized**, with `cover=` reporting how much mass the truncated list actually held (renormalizing would claim precision the top-5 doesn't have); and KL is always computed on the round's **text** (reasoning + content) even when logprobs are available, because engine logprobs typically cover only the content channel and mixing per-channel and whole-round distributions across rounds would make `klPrev` meaningless. Nothing reads these values — no threshold, no intervention, by design: they vary between runs and across quantizations, so they get _observed_ across multiple runs ([[testing-small-models-needs-multiple-runs]]) before anything dynamic is built on them. The one part that touches the engine is self-defending: a backend that rejects the logprob fields gets one silent retry without them and the fields latch off for the session (`client.ts`), so instrumentation can never cost a turn.

Reality check the whole subsystem is built around: at Q2 on a vague task the model is ~50/50 to converge vs spiral, and the harness can't move that — it only bounds what the failing half _costs_ (a clean honest stop in minutes, not a 30-minute spiral or a garbage plan). The lever that moves the _rate_ is input clarity / plan grounding, not more intervention code. A clean `commitSpiralStop` is also machine-distinguishable from a converged/wrong plan, so multi-run evals can _count_ outcomes instead of guessing.

Same experimental discipline throughout: keep each subsystem's constants/helpers together and clearly marked while flag-gated, and prefer fixing output-dialect plumbing (`client.ts`) over adding intervention — many "the model is stuck" symptoms have been harness bugs (reasoning-channel markup leaks), not capability.

## Bundle and prompt caching

`ContextBundle` is built once via `bootstrap()` and treated as stable across turns to maximize prompt caching at the provider. Don't mutate it during a session. The only legitimate refresh path is `/cd`, which re-runs `bootstrap()` for a new cwd. If you add a context source, plumb it into `bootstrap()` and the system-prompt builder; never re-fetch per-turn.

**Prefill is the bill, and the debug log states it** (`agent/prefillcost.ts`, issue #195; REIKA*DEBUG-only). On a slow local endpoint prefill is ~80% of a turn's wall clock — 250 s of prefill against 53 s of decode was a measured review turn — so a `cause=mid-history` note is only actionable annotated with what it cost. Every `prefix-cache` line therefore carries `reprocess=<tok> est=<s> rate=<tok/s>`: tokens are the round's prompt estimate scaled by the \_unstable* char fraction (an LCP cache reuses up to the first differing byte, so a pure append's new tail is a real cost too), and the rate is **learned**, the way `calibration` is learned from reported prompt tokens — each round's time-to-first-token divided by what it reprocessed, EMA-smoothed, and threaded across turns via `priorPrefillRate` so a turn's round 0 (its most expensive prefill) can already price itself. Two guards keep the number honest: TTFT is prefill _plus_ a fixed per-request overhead, so a round reprocessing under `MIN_SAMPLE_TOKENS` never teaches the rate; and a provider reporting real cache hits (`usage.cachedTokens`) is preferred over the char proxy for the sample. The session's first request has no baseline, so its full-prompt count is a ceiling: printed with `≤`, and never used to learn. The trace is session-long (`PrefixTrace` owned by App/headless and passed to `runTurn`, #426) precisely so a turn's round 0 is compared against the previous turn's last request — the one the engine still holds — instead of resetting to a ceiling at every boundary; a subagent gets its own, since its turns interleave with the parent's. An unlearned rate prints `est=? rate=?` — never an omitted field, which would read as a cheap round. Measurement only: nothing branches on these numbers.

**Keep the system prompt provider-neutral.** Don't add model-specific control tokens (e.g., Qwen's `/no_think`, gpt-oss Harmony headers, Mistral instruction tags) to `prompt.ts` — they're junk text for any non-matching model and waste tokens. Inference-engine flags (`--reasoning off` for llama.cpp, `temperature`, etc.) are the right layer for model-specific tuning.

**Prompts are built as string arrays joined with `.join('\n')` / `.join('\n\n')`, not template literals** (`prompt.ts`, `loop.ts` ledgers, `compaction.ts` recaps, etc). Don't "tidy" these into multi-line template literals — it looks cleaner but is the wrong call here. A template literal bakes source indentation into the output (these builders are nested 2 levels deep, so every line would carry leading whitespace — junk tokens the model pays for — unless left-aligned to column 0 or run through a `dedent` helper). The array keeps source-clean and output-clean the same thing for free. It also composes optional sections cleanly — `parts.push(...)` under an `if` (project summary, repo map, plan-mode line) vs. threading `${cond ? … : ''}` ternaries through the prose — and single-sources the separator. Perf is a non-issue at prompt size; this is purely ergonomics + clean output.

## Context management

Three layers keep a long session inside the model's window. They only engage when a window is
known: `REIKA_CONTEXT_WINDOW`, or failing that what the endpoint reports (#417,
`provider/contextwindow.ts` — `GET /v1/models`, llama.cpp's per-slot `meta.n_ctx` or vLLM's
`max_model_len`, floored to the thousand; never `n_ctx_train`, the trained length, which would
claim 131k on a `-c 24576` server and then nothing compacts). Probed once at startup and on a
`/model` switch to a profile without one, recorded on that profile only (`contextWindowProbed`)
so an ad-hoc profile inheriting from it re-probes rather than carrying another model's number;
a server that reports nothing leaves the window unset — the gauge shows absolute tokens and
nothing is capped. A probe that never **reached** a server (llama-server still loading when
reika started) is asked again at the next submit, awaited so the window governs that turn; one
the server answered without a window is not, since asking again changes nothing
(`ContextWindowProbe.reached`, `windowRetryRef` in `App.tsx`). Each layer has a non-obvious invariant — don't "simplify" them without
reading why:

- **Calibration** (`loop.ts`): the char/4 token estimate (`tokens.ts`) systematically
  under-counts dense tokenizers (code/JSON/CJK). After each call we learn
  `realPromptTokens / estimate` and persist it across turns (turns re-seed the full
  history from the UI scrollback, so the factor must carry over). Everything below uses it.
- **Fit-to-window payload cap** (`toolcall.ts`): fresh tool payloads are truncated to the
  room left after everything else, so a single big tool result can't overflow. The room left
  reserves `minGenTokens` for the model's reply — the same generation reserve compaction and
  the backstop use (see below). The split that matters is **measured vs. guessed**, not fresh vs.
  non-fresh. Anything this request introduces — the fresh payloads, plus the trailing round's new
  reasoning and summaries — prices at a pessimistic density floor (`CAP_DENSITY_FLOOR`, 2.5 ≈ 1.6
  chars/token), because a dense turn 400'd a 24.5k window when the _fixed overhead_ (SVG path data /
  CSS in freshly-kept reasoning) was counted at the learned prose average. Bytes a previous request
  already carried price at the learned `calibration` instead, floored at char/4 (`SENT_DENSITY_FLOOR`,
  same value and reasoning as `COMPACTION_CALIBRATION_FLOOR`) — that calibration _is_ the measurement
  of them, and charging them the 2.5 guess over-billed retained content ~2.5× until the fresh budget
  went negative and every read collapsed to `SMALL_PAYLOAD_FLOOR_CHARS` (#189; worst under
  `REIKA_PREFIX_STABLE`, which never ages a live payload). Compaction and the cap now agree on what
  retained content costs instead of disagreeing by 2.5× on the same bytes.
  The truncation marker says "context limit, not a command error" on purpose — without it, models
  loop re-running with different shell flags.
- **Task-spec pin** (`toolcall.ts` `taskSpecIndex`, always on — #227): aging is oldest-first with no
  notion of which payload defines the task, and `/issue` / `/review` both mandate a `gh` fetch as the
  opening call — so the payload holding the task definition was always the _first_ one dropped, after
  which its summary (`Ran: gh issue view 213 (505 bytes output)`) reads to the model as a result it
  already handled. Observed: "let me re-read the issue", no tool call, then a fabricated issue body.
  The fix pins the current turn's _opening_ tool payload (capped at `TASK_SPEC_PIN_CHARS`, 4096 — same
  number and trade as `PROTECTED_READ_FLOOR_CHARS`) so it serializes live past the trailing block, is
  allocated verbatim ahead of everything in `freshPayloadCharCap`, and is skipped by
  `batchAgePayloads`. Two non-obvious rules: it's the _opening_ payload, not the first small one (a
  huge first result means this turn didn't open with a spec fetch, and aging should stay free to
  collapse it); and it releases only when the next turn lands its **own** first tool result, not when
  the user hits enter — releasing at round 0 would shrink mid-history bytes on the exact request
  `warm.ts` prebuilt, which `warm.test.ts`'s strict-prefix assertion catches. Prefix-stable mode
  leaves the pin entirely to batch aging: resurrecting bytes that already serialized as a summary is
  the mid-history rewrite that mode exists to prevent. `dedupToolContent` signs the pinned message as
  a payload so "the signature is what WOULD be serialized" stays true. The `spec-pin` REIKA_DEBUG line
  reports the index, size, whether the pin is currently `holding` (the spec has fallen outside the
  trailing block, so the pin is the only reason it survives) and whether it is `stale` (it predates
  the current user message — the deliberate carry-over that keeps round 0 append-only, which spends
  up to `TASK_SPEC_PIN_CHARS` on the previous task's detail until this turn lands its own first tool
  result). `stale=true` is the one behaviour here that could read as task conflation, so it is
  greppable rather than something to re-derive from the history.
- **Dropped-payload ledger** (default on since 2026-09-18; `REIKA_DROPPED_LEDGER=0` is the baseline arm — `loop.ts`
  `buildDroppedPayloadLedger` — #227): an aged tool
  message serializes to its summary alone — `Ran: gh issue view 213 (505 bytes output)` — which reads
  to a model as a result it already saw and handled, not as content that is GONE. Observed on a
  `/issue` turn: after both `gh` payloads aged, the model wrote "let me re-read the issue once more",
  made no tool call, and quoted issue text that does not exist. Same affordance rule as the
  truncation marker: an unservable state must be loud rather than silently look like success. Stated
  **once per request as a ledger**, not per message — `hasDroppedPayloads` (`toolcall.ts`, beside the
  serialization branches it mirrors) gates it, so it can never make a false claim — it excludes the
  pinned task spec, since the pin keeps that one live and a request whose only summary-only payload
  is the spec has dropped nothing — and it rides the
  same transport as every other ledger (system suffix; the trailing note under `REIKA_PREFIX_STABLE`,
  where the tail is rewritten each round anyway). There are **four** live compositions — {plan,
  agent} x {system suffix, trailing note} — and plan-mode-under-prefix-stable builds its own suffix
  inline, so a change here has to touch it too; `loop.droppedpayload.test.ts` (system suffix) and
  `loop.droppedpayload.prefixstable.test.ts` (trailing note, driving runTurn) cover all four between
  them, because a unit test on `buildSteadySystem` reaches only two. The
  plan **force-write** round is excluded on purpose: that prompt's job is "stop calling tools and
  write the plan", and the notice ends with "re-run that call". All four sites route through one
  `droppedPayloadLedgerFor` gate rather than repeating `FLAG && hasDroppedPayloads(...)`, since a
  half-applied flag is the mistake that already happened once here. **It shipped flagged off first
  because it is a prompt-level bet with a measurable downside**, not just an absent upside: "re-run
  that call" can induce re-fetching of aged results — the dup-aged read loop the ledger→withdrawal
  ladder exists for. The single-variable A/B that turned it on (`/review 225`, n=3 off / 2 on) split
  the way the feature predicts — the baseline reconstructed a dropped diff from memory and only then
  doubted itself; the ledger arm said "the output got dropped, let me re-run it" and re-fetched — and
  the re-fetch loop never showed, with the ladder bounding it if it does. Transcripts were the only
  instrument that saw anything (see the `dup-aged` caveat below). The `dropped-ledger` REIKA_DEBUG line reports
  `active` / `payloads` / `via` (system suffix vs trailing note), read off the **composed** request
  rather than by re-running the gate — with four composition sites, re-deriving "did it fire?" is
  how a check drifts from what shipped, and without it an unmoved `dup-aged` can't distinguish "the
  notice didn't help" from "the notice never fired". `evals/readtrace-report.ts` reads
  `read-trace-summary` (dup-aged / maxrepeat / looped), `spec-pin` and `dropped-ledger` out of a
  REIKA_DEBUG log and diffs two arms — and **validates the arms before the numbers**: it stops on an
  arm whose build has no `dropped-ledger` lines at all (the feature isn't in that build, so the flag
  was read by nothing), and calls two arms with identical `flags` lines a variance baseline rather
  than a result. Every session writes that `flags` line (`debug.ts` `formatExperimentFlags`,
  enumerated from the environment so it can't go stale, values numeric-or-`set` so keys and paths
  never land in a log), because an A/B was once lost to an arm run from the wrong branch: by
  filename it looked like a clean on/off pair, and both arms were the same configuration; per the small-model variance
  rule, concatenate 3+ runs per arm and read the aggregate, not the per-turn rows. The per-message form was tried and rejected: at
  ~90 chars against a ~34-char aged summary it measured 2,730 chars on a 30-round turn (~19% of the
  serialized request), and being mid-history it moved the compaction trigger, the keep boundary and
  the cap arithmetic at once. The ledger is 415 chars, flat, and touches no budget walk. Composition
  order matters — it goes first, ahead of the other ledgers, in **both** `buildSteadySystem` and the
  agent loop's inline mirror, or the warm prefix diverges from round 0 (`warm.test.ts` locks them).
- **Payload dedup** (default on since 2026-09-18; `REIKA_DEDUP_PAYLOADS=0` is the baseline arm —
  `toolcall.ts` `dedupToolContent`): collapses a tool message whose serialized content
  byte-identically repeats an earlier one (an aged summary trail like `Read A / Read A / Read A`, or
  simultaneous parallel-read payloads within a round) to a back-reference, so raw repetition never
  accumulates in context to prime a loop — deterministic, keep-first, and it frees the stubbed dup's
  window budget for the survivors. Benched **null** on multi-file coding turns (payload-aging already
  collapses cross-round re-reads to summaries, so the surviving dedup surface is rare). It is
  **bypassed whenever prefix-stable is active** (a stub flipping on a later duplicate is a mid-history
  rewrite), so with a context window set it changes nothing; it reaches only the no-window and
  `REIKA_PREFIX_STABLE=0` setups — where per-round aging already rewrites mid-history every request,
  so a stub costs no cache validity, and where every older payload is a summary, so the trail it
  collapses is the whole tool history. Defaulted on for that reason: null upside measured, no
  downside found, and `.env.example` had shipped it on already. Strict no-op when off.
- **Compaction** (`compaction.ts`): once the calibrated estimate crosses
  `(window − minGenTokens) × 0.9` — i.e. when the prompt would leave less than the generation
  reserve (plus slack) — the oldest turns fold into one recap message (merged into the system
  block), keeping recent turns verbatim. The compaction _decision_ (and how much to fold) floors the
  learned calibration at 1 (`COMPACTION_CALIBRATION_FLOOR`): a prose-heavy session drives the factor
  below 1, which would let a dense turn sail past the threshold un-compacted (the same 400 as above)
  — flooring at 1 never assumes content sparser than the char/4 baseline. Dense-content _safety_ is
  the cap's job (the guarantee); this just fires compaction sooner so the cap truncates less. The UI
  fill gauge keeps the raw learned factor; only the compact-or-not choice uses the floored one.
  It snaps the keep-boundary _back_ over `tool` messages
  to a tool-call-group start (so no tool result is orphaned from its `tool_call`) and pins the
  original user task verbatim, recapping only what follows. Snapping back rather than forward to
  a user message is what lets it compact _within_ a single long turn — e.g. a read-heavy
  plan-mode exploration that has one user message and no later boundary; the old user-only snap
  found nothing and no-op'd, so the request grew unbounded. Keep/recap budgets are sized off the
  _available_ room (`window − minGenTokens`), not the full window, so the result fits under the
  trigger even when the reserve is a large fraction of a small window. It runs on the persistent
  model history (see the mode table above), so the fold survives the turn; the UI scrollback is
  untouched.
- **Generation backstop** (`budget.ts`): each turn the loop computes `max_tokens =
window − calibratedPrompt − margin` (or the fixed `REIKA_MAX_TOKENS`, whichever is smaller)
  and passes it to `callModel`. It caps a spiraling small/quantized model so it can't run to
  the context end. The cap is a _ceiling_; `minGenTokens` is the _floor_, enforced upstream
  by compaction keeping the prompt under `window − minGen` — so on a normal turn the ceiling
  already lands ≥ the floor and the cap never fires. One number, `REIKA_MIN_GEN_TOKENS`
  (default 2048), drives all three: the cap reserve, the compaction trigger, and this floor.
  Size it ~2048 for reasoning-off models, 6144–8192 for reasoning-on thinking models on a
  small window.

**Tool-output spill (on by default, `REIKA_SPILL=0` disables — `tools/_spill.ts`).** Every
layer above decides what to _drop_; this decides where the dropped bytes _go_. `grep` and `glob`
cap their inline page (100 matches / 200 paths) and, before this, the rest was simply gone — so a
model that needed the tail had exactly one move: re-run the search with a different pattern, which
is the shape most of the observed search loops take (`glob`'s page _was_ the lexicographic head,
so a broad pattern showed one early directory and read as the whole set — see the sampling note
below, which spill is what makes safe). When on, the complete
formatted result is written to a session-scoped temp file (one private 0700 dir per process — reika
is one process per session — removed on exit; files are `wx`+0600 so a planted symlink can't
redirect the write) and the inline payload gains a footer naming the path and both follow-up calls.

**Leftovers are collected at the next startup, not by a signal handler** (`sweepStaleSpills`,
#224). The exit handler only fires on a normal exit — Ctrl-C is one, but SIGHUP (closing the
terminal window, the common case), SIGTERM, SIGKILL and hard crashes are not, and a build-heavy
session can leave tens of MB of 4MB `bash` tails behind per kill. `cli.tsx` fire-and-forgets a
readdir of the temp dir before first paint and reaps every `reika-<6 hex>` directory whose session
is gone. Signal handlers were the option not taken: registering `SIGINT`/`SIGTERM` suppresses
Node's default termination, so we would own the exit in an app whose Ctrl-C semantics are already
custom and whose `bash` sends its own SIGTERM to children — real risk for a temp-dir tidy that
still could not catch SIGKILL or a crash. **Liveness, not age, is what protects a running
session:** each directory carries a `.pid` stamp, and one whose owner still answers `kill(pid, 0)`
is kept at any age, because a second reika idle overnight may still page an artifact it was handed
— exactly the case an mtime threshold alone gets wrong. Age (24h) decides only directories with no
readable stamp: pre-#224 ones, and the millisecond window between `mkdir` and the stamp. A
recycled pid reads as alive and the directory outlives us, which is the safe direction to be wrong
in — the OS temp reaper (~3 days untouched on macOS) is the same backstop it always was. The sweep
runs even with `REIKA_SPILL=0`: the no-op-when-off rule governs what we write and what we offer the
model, and stranding an earlier session's bytes is not a service to somebody who turned the feature
off.
**The locator is kept short** (`reika-<6 hex>/grep-1.txt`, 23 chars below the system temp dir,
down from 48) because the model has to retype it verbatim: a Q2 model was observed dropping one
character out of the original ~100-char path and never recovering it, which turns the recovery
path into a failed `cat` — the loop spill exists to prevent (#144). That is also why the per-file
suffix is a counter rather than random hex, and why the directory is created with an exclusive
`mkdir` rather than `recursive: true`: a short name collides more readily, and silently adopting
an existing directory is the one outcome that must not happen.
Deliberately **no new tool**: the locator points at `read` and `grep`, which the model already uses
constantly, so following it needs no learned behavior beyond reading a path — the reason this is
worth trying where an explicit recall tool wouldn't be. The footer lives in the payload, not the
summary, for the same reason `read`'s "more below" marker does: the summary is what survives
payload aging, and by then a locator is stale advice. Fail-open throughout (a failed write returns
the ordinary capped result with an honest "could not be saved" footer — a search must never become
an error because a temp file didn't land), and a strict no-op when off, including `grep`'s
collection ceiling: spilling raises the walk's stop from 100 to `SPILL_MAX_MATCHES` so there
is a "rest" to save and the count in the summary is a total rather than a floor, which is the one
real cost here — more scanning on a search broad enough to blow past the inline page. Same
experimental discipline: constants and helpers together in `_spill.ts`, clearly marked.

**`fetch_url` spills on a different trigger, and its locator rides the summary** (#139). The search
tools spill what their own cap drops; a fetched page has a second, earlier cut the tool cannot see —
the context window. A page well under the 64KB tool cap is chopped at serialization once the window
is nearly full (`capPayload`, head 40% / tail 60%, or the whole payload at cap ≤ 0), and the marker
at that cut says to read a narrower range. For every other tool that is a real remedy; for
`fetch_url` there is no narrower fetch, so the observed moves were a re-fetch (same page, chopped the
same way) or `bash curl` (a second egress, raw HTML, chopped the same way). So the tool saves every
page over `SPILL_MIN_CHARS` (2048 — the serializer's `SMALL_PAYLOAD_FLOOR_CHARS`, below which a
payload is always delivered whole), not just over-cap ones, and the marker's advice becomes true:
the page is a local file and `read` takes a line range. The locator is in the summary as well as
the footer, the opposite of the search tools' choice above, because the two reasons the summary
matters are both real for a page: it is the only part of the result that survives a fully-starved
window, and the model comes back to a URL it already fetched (#296) — there the locator is the
re-fetch avoided, not stale advice. The cap itself stays in `extractUrl` for the harness callers
(the URL grounder, pasted-URL expansion): only the tool asks for the page uncut, so a grounding
check never writes a file whose locator nobody sees. Peak memory is unchanged — the full extraction
was always in memory before the slice.
**The saved page is also the answer to the same-URL re-fetch** (#296). A model whose fetch has aged
out of the window fetches the URL again — a second full request upstream for bytes we already hold,
and a page that comes back to be chopped the same way. `fetch_url` keeps a session map of URL →
saved file and serves a repeat from the file: no request, no budget (the budget bounds egress, and
this is none), the same result shape, and a summary that says it was served from the saved copy.
The alternative #296 proposed — exempt fetch payloads from aging — was not taken: an exemption
shrinks the pool every other payload ages in, so folds come earlier for everything else, and a
handful of fetches would pin ~100KB of mostly nav chrome for the session. What has to survive is
not the bytes but the fact that the session has them, so the compaction recap grows a `Pages
fetched:` line (URL → locator, capped at 10, outside the entry budget next to `Files touched`),
the fetch analogue of the file-coverage line — a page the session read stays addressable through
every fold. Failed fetches and pages under the spill floor have nothing to point at and are left
out.
**`search` does the same with the query as the handle** (#297). A result list ages out like any
payload and should: the model followed one of eight links or lifted one snippet, and the rest was
never worth the window. What it keeps is the summary, which quotes the query verbatim — a few
words, and exactly the string a model copies back into `search` when it wants the list again. The
tool keeps a session map of query → results and serves that repeat from it: no request, no budget,
no latch check (none of the three reaches upstream), and a summary that says it was served from the
saved results. Keeping the top few results in the recap instead was considered and not taken — at a
16k window it is the cost the query avoids, and the served repeat gives the model all eight for
free. The recap grows a `Web searches run:` line (quoted queries, capped at 10, outside the entry
budget) — "Web" to keep it apart from the plan ledger's `Searches run`, which lists grep patterns.
Searches that found nothing or failed have no list to come back to and are neither saved nor
listed. `parseSearchQuery` lives next to the summary format it reads.

The ceiling is `SPILL_MAX_MATCHES` (300), and it is where the two tools stop being symmetric.
Glob's spill is free — the crawl already holds every path — while grep's is paid on _every_ search
broad enough to blow past the inline page, whether or not the model ever opens the artifact. Eval
runs (`evals/fixtures/06-08`) put that at roughly one time in three when a shell is available:
asked which files define a symbol, the model answers with `grep -r … | sort -u` in 98 bytes rather
than paging a saved result, and it is right to — a query that projects the matches down beats
reading them all. Follow-through rises without a shell (`grep-spill-noshell`, `planTools()`) and is
3/3 on glob, where "last path alphabetically" has no narrower query that produces it. That is the
generalization worth keeping: **spill pays off where the query cannot be reshaped to shrink the
result**, which is structural for glob and occasional for grep, since grep takes a pattern that can
always be narrowed. So 3x the page for 3x the scan is the trade that survives a one-in-three hit
rate; 10x did not. Measured on one model family (Q2–Q4 local); a stronger model would likely
reformulate _more_ readily, not less, so do not expect the grep rate to rise with capability.

**`bash` spills a bounded _tail_** (`bash.ts` `TailWindow`, `SPILL_MAX_BYTES` 4MB, same
`REIKA_SPILL` flag). The search tools buffer then truncate; `bash` did neither — it stopped
_draining_ the stream at the payload cap, so the tail was never read at all. That is the wrong end
to lose: a build or test run puts the failure at the _end_, which is exactly what head-truncation
throws away. The drain now always runs, and a second bounded buffer keeps the last ~4MB while the
payload keeps the same 64KB head as before, so the flag stays a clean A/B on the bytes the model
reads. (The _summary_ is not part of that A/B: it reports the command's real output size in both
states. It used to report `totalBytes`, which stops at the payload cap, so with the flag off a
234KB run was described to the model as "65536 bytes output" — a claim about the output, not about
what was kept, and false either way. A wrong number in context is not worth a tidier A/B claim.)
This needed no stream
restructuring — the reason it was scoped out of the original spill work: a ring beside the existing
buffer plus one write at close does what write-through would, and the retained window is what
bounds memory, so a runaway `yes` still cannot grow the process. The window is chunk-granular, not
byte-exact (whole chunks drop off the front, retaining between 4MB and 4MB + one chunk, ~2% slop) —
a chunk edge is no more a line edge than a byte-exact cut would be. On a run bigger than the window
the payload is the head and the file is the tail with a gap between, and the footer says so
("the middle was dropped") instead of claiming a full result: a model told the file is complete
will not think to doubt a gap in it.

**The UI chip shows the end of the run too**, from its own small always-on window
(`UI_TAIL_BYTES`, 4KB) rather than from the spill window — so it is honest with `REIKA_SPILL` off,
and the user's view does not depend on whether the model's artifact was written. It used to be
built from the capped payload, which meant a truncated run showed the last ten lines of the first
64KB: content from the _middle_ of the run, printed where a reader looks for how it ended. Nothing
about it was false (the marker did say output was omitted) but on `npm test` it showed test 4300 of
9000 instead of the failure. The omission marker moved above the lines and became
"…(earlier output omitted)" to match: the tail is the end, so whatever was dropped came before it.
The two channels now legitimately disagree — the model gets the head plus a locator, the user gets
the end — which is the right split, since only one of them can follow a path to the rest.

Measured (`evals/fixtures/09-10`, 3 runs each on `kat-coder-qq2`): follow-through is not the
problem. Five of six spill-on runs reached the artifact, and all three one-shot runs read it as the
very _next_ call after the capped result, reporting a seed that existed nowhere else — unforgeable
evidence the tail crossed into context. **The baseline is what qualifies that.** With the flag off,
09 still answers correctly (`wc -l` recomputes the verdict), and 10's model neither fabricates a
seed nor gives up: it re-runs the checker narrowed and reports a real seed from the _second_ run.
So what bash spill buys is **a re-execution avoided**, not an otherwise-unanswerable question
answered — and what that is worth scales with what the command costs to run twice, which a cheap
fixture script cannot price. The frequency question (what share of real `bash` calls exceed 64KB
at all) is telemetry, not an eval, and is still open.

**The locator is a transcription hazard for small models**, found by a 09 run and belonging to
`_spill.ts` rather than to any one tool. The model reached for the artifact correctly — `tail -50
<path>`, which is following the locator, just via the shell instead of `read` — and dropped a
character out of the ~100-character temp path (`…sz0b2wbh…` → `…sz02wbh…`), then never named it
correctly again. Roughly 100 characters of tmpdir hash + `reika-spill-<pid>-<8 hex>` +
`<name>-<6 hex>.txt` is a lot of exact copying to ask of a Q2 model, and grep/glob hand out the
same shape.

**Spill stats (`REIKA_SPILL_STATS=1`, off by default — `tools/_spillstats.ts`)** answer the one
question the fixtures cannot. An eval shows that a model follows a locator when the answer is only
in the artifact; it cannot show what share of a real week's `bash` calls exceed 64KB at all, and
that is what decides whether a retained window is sized right or is provisioned for a case that
fires twice a month. One JSON line per over-cap result (`tool`, `total`, `shown`, `spilled`, and
for bash whether the window held the whole run) plus one per call that opens an artifact, appended
to `~/.config/reika/spill-stats.jsonl`. Sizes and tool names only — never output. Deliberately not
on `debugLog`: that sink truncates per session (#114) and turns on a flood of unrelated
diagnostics, and a passive week-long measurement needs a file that costs nothing to leave enabled.
JSONL rather than a tally because the distribution is the point — "how big" and "how often" need
the individual sizes. The `capped` events without matching `followed` events are the interesting
ratio: windows retained for nothing. Bash records its event whether or not `REIKA_SPILL` is on,
since over-cap frequency is a property of the workload rather than of the flag.

**Over-cap glob pages are sampled, not the head** (`glob.ts` `sampleAcrossEntries`). A capped page
sorted lexicographically is one alphabetical _region_ of the tree, not a view of it: on a 2300-file
monorepo `**/*.ts` matched 560 files whose 200-path head covered 3 of 5 top-level packages, two
absent entirely, with nothing saying a region was missing rather than a tail. Slots are dealt
round-robin so every entry is represented before any gets a second path, and exhausted entries
redistribute their surplus (that repo's five entries come out at 2 / 73 / 72 / 22 / 31 — the three
small ones complete, the two large ones splitting what is left). Allocation is round-robin;
output is **grouped**, not interleaved — a page alternating between packages line by line is harder
for a small model to read structure from than contiguous sorted runs, and "round-robin" naturally
reads as interleaved, so there is a test pinning it. It is unconditional rather than a mode for the
_model's_ sake, not config tidiness: with two modes it cannot tell whether the paths in front of it
are the sorted head or a cross-tree sample, so it can reason safely about neither, and the cap is
already the one transition it can see (it is where the footer changes). Sampling is only non-lossy
because spill keeps the complete sorted list in the artifact — which is why this landed after
`REIKA_SPILL` and not before. Measured: 6/3/6 tool calls against a baseline of 8/9 on the same
prompt. What it did **not** do, against prediction, is improve coverage _answers_ — runs still
omitted a 2-file entry that sampling places on lines 1–2 of the page. Aggregating ~200 paths into a
correct five-name set is near the model's ceiling at Q2 (byte-identical inputs produced both a
perfect answer and one with three confabulated directories), and page composition cannot move that.
The page carrying the information is the deterministic win; whether the model uses it is a separate
question with a separate answer.

**Reasoning pruning** (`toolcall.ts`): historical `reasoning_content` is kept only for the
last `REIKA_REASONING_ROUNDS` tool-call rounds (default 2; the active roundtrip is always
among them — see the cross-provider note) and dropped elsewhere. Unbounded, a thinking model
accumulates reasoning every round and starves the budget; pruned to 1, it re-derives the same
analysis across rounds (and a `repeat_penalty` can't suppress what's no longer in-window).
Keeping a small recent window is the balance — raise the env var to trade tokens for
chain-of-thought continuity, lower it under context pressure.

**Prefix-stable mode (`REIKA_PREFIX_STABLE`, default ON with a window since #181; `=0` is the
baseline arm — issue #69).** The layers above buy window room by _rewriting earlier request
bytes_: payload aging rewrites the previous round's tool messages every round, reasoning pruning
drops older `reasoning_content` mid-history, and the regenerated ledgers/nudges mutate the system
block. Every such rewrite invalidates the inference engine's prompt-prefix cache from that byte
on — and SWA/hybrid-memory models can't partially restore at all, so ANY divergence re-processes
the FULL prompt (observed ~3 min/request on a 35B at 17k tokens; #181 priced one mid-context edit
on a 27B at 22.9 tok/s prefill: 8453 tokens re-processed, 7.9 min, against 25 tokens / 3.5 s for
an append — and `--cache-reuse` on the engine side was byte-identical, so only the harness can
fix it). When on (requires `REIKA_CONTEXT_WINDOW`; silently inactive without one), requests stay
**append-only between shrink events**: payloads stay live with byte-frozen renders (`Message.rendered`, stamped only on the real call path — estimates
never stamp, so freezing doesn't depend on debug timing) until the calibrated estimate crosses
the same threshold compaction uses, then `batchAgePayloads` (`compaction.ts`) sheds them
oldest-first down to a 0.7 watermark (`AGE_LOW_FRACTION`, overridable via
`REIKA_AGE_LOW_FRACTION` for A/B, clamped to 0.3–0.95) in the _same_ request compaction fires in —
one amortized cache invalidation instead of one per round, with the active roundtrip always
protected. How deep that watermark should be is an open, measurable question (#253): each event
re-processes most of the prompt, so shedding further means fewer events per run, at the cost of a
smaller live working set between them — which #251 showed is what keeps the model on task. Measure
it with `evals/prefixcost-report.ts`; don't argue it.
Aging sweeps twice, shedding bulk before crumbs (#257): a payload under `SMALL_PAYLOAD_CHARS` is
skipped on the first sweep, because relief that small can't plausibly be what tips the estimate
under the watermark while losing it can cost a whole re-read round — and the re-read puts the
payload straight back, pulling the next shrink event forward. The second sweep takes the crumbs too,
so the floor only ever reorders; it can never keep an event from reaching its watermark. Reasoning
is aged on the first sweep at any size, since the model can't re-fetch its own reasoning. When
aging fires but can't reach the watermark (it stops at the protected tail, and on a small window
the system prompt + the active round's reads are most of it), compaction is pulled into the same
event — otherwise the estimate hovers just under the threshold and the next round immediately
re-fires, i.e. consecutive full re-processes (observed on a 24k window).
Reasoning retention follows the same sticky boundary (`reasoningAged`) instead of last-N-rounds,
and the per-round ledgers/nudges ride a transient trailing user message instead of the system
suffix (their "auto-generated — not user input" headers carry the framing). Aging marks are set
on the shared message objects deliberately — like compaction's splice into the persistent model
history — so liveness and frozen bytes carry across turns and the next turn's first request stays
prefix-aligned.
The trade: requests sit fuller on average (slightly slower decode; more stale payload in the
model's view — the per-round collapse was accidentally also noise discipline for weak models),
in exchange for near-zero prefill on cached rounds. Note `ReadTrace`'s dup-live/dup-aged split
still assumes one-round liveness, so under the flag its classification is conservative (a loop
on still-live content fires one repeat later). Bench with the always-available `prefix-cache`
REIKA_DEBUG line (`agent/prefixtrace.ts`): it classifies each request's divergence from the
previous one (`append-only` / `trailing-note` / `system-changed` / `mid-history` / `shrunk`) with
the stable-byte fraction — flag off you'll see `mid-history` every round; flag on should be
`trailing-note` (the transient note's own slot, a fixed ~400 chars, displaced by the round's
append) or `append-only`, with occasional `shrunk`. `tools-changed` outranks every message-level
cause and counts nothing stable: the trace compares the tool list too (#426), because a template
renders it into the system turn and the messages alone cannot show that the prompt changed from
its first bytes. Expect it on the withdrawal ladder (the inspection tools leave and later return —
each transition is a full re-prefill, accepted because it is breaking a loop) and nowhere else;
the compaction-note round logs its own `phase=report` line, which should read `trailing-note`. `trailing-note` exists because that case used
to report as `mid-history firstChanged=assistant`, which reads as aging invalidating the cache
every round when the round was a pure append (#253). A cache line alone can't tell overhead from
growth — for that split, and what each shrink event cost in wall clock, run
`evals/prefixcost-report.ts` over the log. Same experimental discipline: constants and helpers together, clearly
marked.

**Speculative KV-cache warming (`REIKA_WARM=1`, default off, experimental — issue #81, `agent/warm.ts`).**
The complement to prefix-stable mode: instead of keeping the cache _valid_, it prefills the cache
_earlier_. On the first keystroke of a prompt (App wires it to the input's first change), a throwaway
1-token request is fired carrying the exact prefix the eventual submit will send — system + history,
minus the not-yet-finished user message — built by `buildRoundZeroPrefix` (the same round-0 assembler
the real call uses, so the bytes match and a llama.cpp-style server prefills its prompt-prefix cache
during the typing gap; the real request then re-processes only the user message). Fail-open: an aborted
or errored warm just wastes a token, and a strict no-op unless `REIKA_WARM=1`. Skipped when the next
turn would compact (the prefix would diverge, so warming the stale one is wasted) and self-dedupes so a
burst of keystrokes fires one warm, not one per key. Interacts with prefix-stable via `prefixStableActive`
so the warmed bytes track that mode's assembly. Best on slow-prefill local setups; a needless (tiny) cost
on paid APIs — hence off by default. Same experimental discipline: constants and helpers together in
`warm.ts`, clearly marked.

## .gitignore is honored

Bootstrap loads `.gitignore` (and `.git/info/exclude`, plus nested `.gitignore` files re-rooted to their directory — see `scopeGitignore`) into one `Ignore` instance on `bundle.ignore`. Any walker that touches the filesystem MUST consult it: `buildFileIndex` (fdir exclude+filter), `buildRepoMap` (manual walk), `list` / `grep` / `glob` tools (via `ctx.ignore`). New walkers added to tools or context modules MUST do the same — otherwise the agent burns exploration on build outputs.

## Config sources

`loadConfig()` reads dotenv from cwd `.env` first, then `~/.config/reika/.env` as fallback. Shell env vars take precedence over both (dotenv's no-override default). Order matters — don't reorder without thinking about precedence.

## Last session state (#365, `src/laststate.ts`)

`~/.config/reika/state.json` holds `{ mode, profile }` from the last session, and the TUI opens on them. Precedence is **launch env > saved state > `.env`**: `config.ts` snapshots `Object.keys(process.env)` before dotenv runs (`setAtLaunch`) — the keys already there are the ones the shell handed us, which dotenv's no-override default keeps intact — so `REIKA_DEFAULT_MODE`/`REIKA_PLAN_EXPERIMENT` at launch pins the mode and `REIKA_MODEL` at launch pins the profile to `default`. A shell-rc `export` is indistinguishable from a command-line flag and counts as one. Saving is two `useEffect`s in `App.tsx` on `mode` and `activeProfile`, not a call at each switch site, so a new route to a mode (`/implement`, `/clear`, the picker, cycling) can't miss it; only `DefaultMode`s persist (`persistableMode`), and the profile effect waits for the config so the initial `'default'` can't overwrite the value being restored. A saved profile the config lacks (ad-hoc `/model` targets included) falls back to `default`. Fail-open both ways; headless never touches it. Resuming off the env default prints a persistent `Resumed …` line — a plan-mode start answers a task with a plan, so the user must see it. App render tests mock the module: the real one would start a test in whatever mode the developer used last.

## Profiles

`Config.profiles` is a map of named `Profile` objects (`model` + `baseURL` + `apiKey`). The "default" profile is always present, derived from the flat `REIKA_MODEL`/`BASE_URL`/`API_KEY` keys. Additional profiles come from `REIKA_PROFILES=kimi,gpt4` + per-profile `REIKA_<NAME>_MODEL` etc.

When calling `runTurn`, App.tsx passes `resolveProfile(config, activeProfile)` rather than raw config — that overlays the active profile's `model`/`baseURL`/`apiKey` onto the rest. `/model <name>` updates `activeProfile`. Profile names are lowercased on load; matching is case-insensitive.

Subagent overrides (`REIKA_SUBAGENT_*`) are independent of profiles — they always come from the top-level config regardless of which profile is active. This is intentional: subagent model selection is a separate axis from main-thread model selection.

**Per-profile `maxTokens`:** an _explicit_ ceiling on response tokens, falling back to the global `REIKA_MAX_TOKENS`. It is no longer the only source of `max_tokens`: when `contextWindow` is set, the loop computes a per-turn backstop (`window − prompt − margin`, see the Generation backstop above) and sends `min(REIKA_MAX_TOKENS, backstop)`. With no window known and no `REIKA_MAX_TOKENS`, `max_tokens` is omitted (server default). An explicit `REIKA_MAX_TOKENS` still wins as a hard cap, so setting it too low truncates tool-call JSON silently — keep ≥4k for tool-heavy use, or just leave it unset and let `minGenTokens` size the reserve.

**Per-profile `minGenTokens`** (`REIKA_<NAME>_MIN_GEN_TOKENS`): the generation reserve, falling back to the global `REIKA_MIN_GEN_TOKENS` (default 2048). One number drives the cap reserve, the compaction trigger, and the backstop floor — set it larger (6144–8192) on a small-window profile running a reasoning model so compaction fires early enough to leave think-room.

## Attaching images

Issue #49. The terminal never delivers image bytes — a paste is always text — so reika reads the system clipboard itself on **ctrl-v** (not cmd-v: macOS terminals never forward the ⌘ key, and their own cmd-v paste yields nothing for an image). Two capture paths, one interpretation path:

| Path                       | Where                                                          |
| -------------------------- | -------------------------------------------------------------- |
| ctrl-v (clipboard)         | `src/ui/clipboard.ts` → `Input.tsx` → `App.tsx` `onPasteImage` |
| `@shot.png` / dropped path | `src/agent/mentions.ts`                                        |

Both funnel into an `OcrProvider` (`src/ocr/types.ts`) and come out as a text `<image>` block, structurally identical to the `<file>` block a mention produces. **This is why the feature is model-agnostic:** the model only ever sees text, so a text-only local model handles a pasted screenshot exactly as well as a vision one — and `Message.content` stays a `string` end-to-end. A vision fallback would instead need multimodal content parts threaded through `messagesToChatParams`, compaction, the payload store, and the prefix-stable `rendered` bytes; the `OcrProvider` indirection exists so that can slot in later without touching the call sites.

`@napi-rs/system-ocr` is an **optional** dependency: it ships prebuilt N-API binaries for macOS and Windows only (no node-gyp, no compile step), and npm silently skips the non-matching platform packages. It goes in `optionalDependencies`, so a failed binary fetch never breaks `npm i -g reika`.

### Why recognition runs in a child process

**reika never loads the native module.** `systemOcr` spawns `node -e` with a tiny worker, pipes the image in on stdin, and reads a JSON envelope back on **fd 3**. Two hard-won reasons, both from real failures:

1. **A native fault is not catchable.** macOS 26's `RecognizeDocumentsRequest` path can fault outright — an observed crash was a `KERN_PROTECTION_FAILURE` on the stack guard page of a `com.apple.root.default-qos.cooperative` thread, inside Apple's own Swift frames (Vision → `librecognize_documents` `formatDocument`/`allLineIDs`). No `try/catch` survives that; in-process it killed the TUI and the user's conversation with it. Out of process it kills a child we can afford to lose, and `parseWorkerResult` turns the signal into a `failed` outcome.
2. **The library scribbles on stdout and stderr.** It prints `VTEST: error: perform(_:)…` to stdout and `falling back to VNRecognizeTextRequest` to stderr. In-process, stdout noise corrupts the Ink frame. Hence both are `'ignore'`d and the result travels on a private fd the library can't reach.

That stderr line is _routine chatter_, not a cause — never surface it as an error detail. Availability is decided by `createRequire().resolve()`, which reads package metadata without ever dlopening the binary; a platform with no binary is reported by the child as `unavailable`.

Cost is one node startup (~50ms) on a ~530ms clipboard+OCR round trip.

A clipboard paste is OCR'd immediately and parked in a ref keyed by an `[Image N]` marker inserted into the input buffer; `attachImageBlocks` expands live markers at submit. Deleting the marker drops the attachment — the marker is the user's handle on it. Attachments are consumed by the turn that sends them so history recall can't silently re-attach.

Failures are **persistent scrollback notices**, never silent: an attachment that vanishes is indistinguishable from the model ignoring it. `no-text`, `unavailable` and `failed` stay distinct because they warrant different messages. Note that `confidence` from the recognizer is deliberately ignored — it reads ~0.44 on character-perfect extractions, so any threshold would reject good text.

## Pasting large text (`ui/pastes.ts`)

Issue #120. The input box lives in Ink's **dynamic** frame, and the rule from `Scrollback.tsx`
applies to it too: once that frame is as tall as the viewport, Ink repaints the whole terminal —
`\x1b[3J` included, which wipes native scrollback — on every render, and the cursor blink alone
renders twice a second. A pasted wall of text therefore doesn't just look bad, it leaves the TUI
unusable until restart (measured on a 400-line paste: 58 scrollback wipes and 2.4 MB of repaint,
vs 0 and 170 KB after).

So a paste at or above `PASTE_LINE_THRESHOLD` / `PASTE_CHAR_THRESHOLD` never enters the buffer:
`App`'s `onPasteText` parks the text and hands back a `[Pasted text #N +400 lines]` marker to sit in
its place, and `expandPastes` splices it back at submit — the same marker-plus-payload shape as
`[Image N]`, and expansion runs **last** so `@`-mentions, pasted-URL fetching and skill routing
all match on the user's own words rather than on pasted content. The marker survives into
`display`, so the user bubble and the input-history entry stay one line while the model gets the
full text. Unlike image attachments, pastes are **not** consumed by the turn that sends them: the
marker is plain text the user can recall from history or leave in a queued message, so the store
is session-long (bounded by `MAX_PASTE_STORE_CHARS`, oldest dropped first).

Two supporting pieces in `Input.tsx`, both needed because Ink has no bracketed-paste support:

- **Chunk coalescing.** A terminal splits a paste at arbitrary byte offsets (observed: 18 chunks
  of 1022 bytes for 400 lines). Each chunk would otherwise be its own edit — and a chunk that
  begins at a line break parses as Return and submits half a paste. Chunks that look like a paste
  (≥ `PASTE_CHUNK_MIN` or containing a newline) accumulate until `PASTE_COALESCE_MS` of quiet;
  everything arriving inside that window is paste content, ctrl-c aside.
- **`clampToViewport`.** The guarantee the threshold alone can't give: past a viewport-derived
  height the box renders a window around the cursor and says how many lines it's hiding, so no
  path (repeated sub-threshold pastes, a long typed buffer) can push the frame over the ceiling.

## Choosing a test instrument

Four instruments, and picking the wrong one is the usual way time gets lost here. **Most questions
about this repo need no model at all.** The rule of thumb: a log tells you the _mechanism_, and
repetition tells you the _rate_ — so if the question is "does X happen", instrument it; if it is
"how often", repeat it; if it is "is this function right", just test it.

| Instrument                                               | Answers                                                             | Cost                       | Picking it wrong looks like                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| **Vitest unit / render test**                            | Given this input, does the module or component do the right thing?  | milliseconds, runs in CI   | Spending a model run to check a string, a slice boundary, or JSX order   |
| **Eval fixture** (`npm run eval`)                        | Does a real model _use_ the affordance — follow a locator, recover? | minutes per run, needs 3+  | An n=1 conclusion; or evaluating logic that has one deterministic answer |
| **pty drive** (`.agents/skills/verify`)                  | Does the whole app render and behave this way in a real terminal?   | a few minutes of setup     | Substituting a render test for keyboard, modal, or abort flows           |
| **Instrumentation** (`REIKA_DEBUG`, `REIKA_SPILL_STATS`) | How often, and how big, in _real_ use?                              | days of passive collection | Trying to infer a rate from a fixture — a corpus you built cannot        |

The boundaries that actually bite:

- **An eval cannot answer a frequency question.** `evals/fixtures/09-10` show a model follows a
  spill locator when the answer is only in the artifact; nothing in them says what share of a
  week's `bash` calls exceed 64KB, which is the number that sizes the window. That is why
  `REIKA_SPILL_STATS` exists — see the spill section.
- **A render test is not a substitute for driving the app**, only for the part it covers. The
  bash chip's tail has a render test _and_ was driven end to end, because "does this Box order its
  children correctly" and "does a real 109KB run reach that Box" are different claims. Reach for
  the pty when the change is what the user _sees_.
- **A fixture's corpus is a choice, and it shows.** A cheap script makes re-running free, so a
  model routes around the artifact and is _right_ to; the same prompt against a 90-second suite
  would not. Build the arm that removes the escape (`10-bash-spill-oneshot`) rather than reading a
  route-around as a failure.
- **Q2–Q3 models have high run-to-run variance** — byte-identical inputs produce 52 / 16 / 6 tool
  calls. Judge any eval change over 3+ runs; a single run is an anecdote.

## Tests (Vitest)

`npm test` runs the unit suite (~5s, ~1000 tests across ~78 files). What earns a test: pure logic
with edge cases (parsers, matchers, path math, aging/dedup rules), a bug you just fixed, and any
_rendered_ output whose shape matters (Ink components have render tests via `ink-testing-library`
— see `Scrollback.render.test.tsx` for the pattern, including how to pin viewport width).

Representative of the bug-prone core rather than an inventory — the suite is far larger than any
list worth maintaining here:

- `src/provider/toolcall.ts` — `messagesToChatParams` (assistant content nulling, tool message `name` field, payload aging)
- `src/provider/client.ts` — `sanitizeToolName`, `extractToolCallsFromContent`
- `src/ui/suggest.ts` — command + file autocomplete matching
- `src/ui/summary.ts` — session stats derivation
- `src/agent/mentions.ts` — `@filepath` expansion, image-path detection, OCR failure notices
- `src/agent/attachments.ts` — pasted-image markers + `<image>` block assembly
- `src/ui/pastes.ts` — large-paste markers + submit-time expansion (`Input.paste.test.tsx` drives
  the paste path through a rendered Input, the one UI component with real keyboard logic)
- `src/ocr/system.ts` — OCR outcome mapping (stubbed module; the real one is an optional dep)
- `src/ui/clipboard.ts` — parsing AppleScript's `«data PNGf…»` literal
- `src/search/searxng.ts` — provider request shape + response normalization (fetch mocked)

**Thin by design, not by policy:** `list.ts`, `write.ts`, and `_walk.ts` are shallow wrappers over
node fs whose behavior is the syscall's — a test there restates the standard library. Everything
else in `tools/` has one, because the moment a wrapper grows a cap, a window, or a footer it stops
being thin (`bash.ts` is the worked example: shallow until it had a payload cap, a tail window and
a spill footer to get wrong).

**When editing a covered module, run `npm test` before declaring done** — and prefer `npm run check`,
which adds typecheck, lint, and format. Tests catch regressions evals can't: an eval only exercises
a path when a real model chooses to invoke it, so a broken branch can pass an eval by never
running.

### Fixtures use generic identities, not the author's

Test fixtures, eval prompts, and code comments are committed and public-facing. Keep real personal
data out of them: no `/Users/<name>/…` paths, no real names, emails, GitHub/HuggingFace handles, no
private project names. Reach for the conventional placeholders instead — `octocat`, `Mona Lisa`,
`octocat@example.com`, `~/…` or `/repo/…` for paths, `example.com`/`example.net` for hosts.

The trap is that this material arrives honestly: you debug against your own machine, the real
values are what you have in hand, and a fixture written from a live transcript or a probe carries
them straight into the repo. `src/ui/identity.test.ts` was written this way first — a test suite
for the anonymization feature, fixtured with the author's actual handle and both email addresses.

Two exceptions, both about asserting behavior rather than naming a person:

- **Environment-derived values.** A test that needs the real `$HOME` should call `homedir()` and
  build the expectation from it, never hardcode this machine's layout. See the `scrubDisplay layer
order` suite — it derives the username from `$HOME` so the assertion is about ordering, not about
  whose laptop ran it.
- **Third-party names that are the point.** `anthropics/claude-code` and `Qwen/Qwen3-30B` appear
  verbatim in `identity.test.ts` precisely because the test asserts they are _not_ scrubbed.

When genericizing, sweep case-insensitively and include comments and doc prose, not just string
literals — the leftovers are usually a lowercased handle inside an explanatory comment.

## Skills

Markdown files in `~/.config/reika/skills/` (global) and `<cwd>/.reika/skills/` (project) load as slash commands at bootstrap. Two layouts supported: a flat `name.md` file, or a directory `name/SKILL.md` (Claude Code convention — lets a skill carry supporting files which we ignore). Loader in `src/skills.ts`; bootstrap attaches the resulting `Skill[]` to `bundle.skills`. App.tsx `handleCommand` falls through to skill dispatch when no built-in matches — built-ins always shadow skill names.

When invoked, the skill body is sent as the user message (verbatim), with any args appended after a blank line. The display in scrollback shows the raw `/skill args` the user typed, not the expanded body. Uses the same `submitToModel` path as regular input, so streaming/abort/approval all work identically.

Reika ships its own skills in `.reika/skills/` (`issue`, `review`) — checked in, so the workflows this repo's development runs on are reviewable and versioned rather than living only in a contributor's `~/.config`. They load as ordinary **project** skills here, and `npm run skills:link` (`scripts/link-skills.sh`) symlinks them into the global dir for use in other projects; it re-points its own links, but never overwrites a same-named file it didn't create unless given `--force`. Two tests in `skills.test.ts` guard the shipped set: every one parses with a description, triggers and a body, and no two share a trigger phrase (a shared phrase ties, and `matchSkill` routes a tie to neither).

**Skills for the agents working _on_ reika live in `.agents/skills/`** (#281) — `verify`, the pty drive recipe — and are a different thing from `.reika/skills/`: those are run by reika's own loader as slash commands the user invokes, where `.agents/` holds recipes for whichever coding agent is editing this repo. `.agents/` is the agent-agnostic home; each harness that wants its own directory gets a symlink into it (`.claude/skills/verify -> ../../.agents/skills/verify`, relative so a worktree or clone resolves it), never a copy — add the next skill under `.agents/skills/<name>/SKILL.md` and link it the same way. A model that isn't Claude Code and needs a workflow this repo has already worked out should look there first.

Filename validation: `[a-z0-9][a-z0-9_-]*` only. Frontmatter (optional) is parsed with a tiny hand-rolled key:value parser — no `js-yaml` dep. It understands the block-list form (`key:` then `- item` lines) by folding items into the same comma-joined string the inline form yields, so consumers stay on `Record<string, string>`. Per the rule-of-five heuristic, the parser still isn't worth a library until skills grow genuinely nested metadata.

### Plain-English routing (`skillmatch.ts`)

A `triggers:` frontmatter list routes an ordinary prompt to a skill **without the model choosing**. `matchSkill` scores each skill's trigger phrases (plus its name, an implicit trigger) against the user's raw input as whole-word matches, weights by phrase word count, and returns the single best — null on a tie, since routing by array order would be arbitrary. `App.tsx`'s `routeSkill` runs it at submit and either emits a one-line suggestion (default, once per skill per session) or, on a strong match (`REIKA_SKILL_AUTO`, default `ask`), asks — a confirm dialog before submit — and prepends the body to the prompt with a receipt naming the matched phrases if the user says so.

Three constraints shaped this, and they're the reason it is **not** a model-callable tool:

1. **A wrong pick costs more here.** At 30B/Q2 on a 16k window, a mis-fired skill body is a large fraction of the budget — where the same mistake on a frontier model is just wasted tokens. Hence the asymmetric thresholds: one trigger earns a suggestion (a line on a turn that runs normally either way), two earn an injection (which rewrites what the model was asked to do).
2. **Selection must precede the prefix.** A skill invoked mid-loop rewrites the request prefix at round N, invalidating the engine's prefix cache — all-or-nothing on SWA models, the exact cost `REIKA_PREFIX_STABLE` and `REIKA_WARM` exist to avoid. Selecting at submit keeps injection in round 0, where it's just part of the user message.
3. **Never route on derived text.** Matching runs on the user's own words, never on the expanded model text — a fetched page or an `@`-mentioned file that happens to say "verify" is not a request to run `/verify`.

Auto-injection wants the shape of a command, not just its keywords (`leading` and `words` on `SkillMatch`). Measured against the two shipped skills: 5 of 5 prompts that merely mentioned the same nouns mid-sentence — "add a pull request template to the repo", "the issue number is shown twice in the header" — cleared the two-trigger bar, each prepending a body whose first line is "run `gh pr view`". Two causes. The skill name is an implicit trigger and was counted _beside_ every phrase containing it ("issue" + "issue number" = 3), so any two-word trigger holding the name auto-injected alone; a matched phrase now absorbs the shorter matches inside it. And after that fix the legit and false cases score the same ("work on issue 412" vs "the issue number is shown twice" are one phrase each), so keyword count cannot separate them — position and length can: a matched phrase must open the prompt (past a `please` / `can you` lead, `COURTESY_LEADS`) and the prompt must fit `AUTO_MAX_WORDS` (12). The residual false positive is a prompt that _opens_ with the noun ("pull request templates live in .github, add one"); the residual false negative is a command with a long instruction tail, which still gets the suggestion line. Both are the keyword matcher's ceiling: a false injection is a turn spent on the wrong workflow, not a stray line. `skillmatch.test.ts` pins the probe prompts.

**The confirm dialog (#425, `ui/Confirm.tsx` — since #448 one generic two-row dialog fed by a `ConfirmSpec`, with `skillConfirmSpec` and `pastedUrlConfirmSpec` as its two askers) makes the user the classifier** where the matcher tops out, and is why routing is on by default: a wrong pick now costs one keystroke, not a turn. The TUI never injects silently: `decideSkillRoute` (`App.tsx`) runs at keypress on a match clearing `shouldConfirmInject` — the auto gate minus `AUTO_MAX_WORDS`, since the word cap priced a _silent_ wrong pick and with a human answering the long-tail command (`review pr 420 but first explain…`) can be asked about instead of only suggested; `leading` stays, or "add a pull request template" would prompt every time, which is the nag. Two rows, numbered like the question dialog: `1. Send as typed` starts selected and `2. Apply /x` is where `y` lands — the inverse of Approval's row order, because there the model already committed to an action and here nothing has happened yet, so a wrong default that injects costs a turn where one that doesn't costs a keystroke (the footer says where `y` goes for approval-trained fingers). Digits and `y`/`n` only move the cursor; Enter is the one key that answers; ctrl-c drops the submit with the prompt still in the box. It fires **before** the busy queue and the expansions: a prompt submitted mid-turn is asked about right then, while the user is present, and `QueuedMessage.skill` carries the answer to the replay (`queuedSkillRouteRef`, the way images ride back onto `imageAttachmentsRef`) so the drain never asks with nobody at the desk; the drain is held while a dialog is up, since a replay under it could open a second one over the first. Decline = the prompt unchanged with no hint line (the dialog was the hint); apply = the existing injection path. The dialog opens in a microtask (Ink hands the Enter that submitted to every `useInput` handler, and a synchronous open would answer itself), and the three modal kinds stay distinct — Approval acts on a model action, Question is the model asking, this is the harness asking before submit. `REIKA_SKILL_AUTO` is three-valued (`parseSkillAuto`, `config.ts`; `SkillAutoMode` in `types.ts`): `ask` (unset) asks in the TUI and sends the prompt as typed in headless; `apply` (also `1`, the pre-#425 spelling) is the one value that changes headless — it keeps the #424 gate (`shouldAutoInject`, word cap included) and injects silently, because nobody is there to ask, while the TUI still asks; `off` and any typo leave only the hint. The default moved to `ask` with the dialog, and `apply` stays opt-in so a `-p` script that never asked for skill bodies does not start receiving them because the interactive default did. `App.skillconfirm.test.tsx` drives all of it through the real App, queue replay included.

`shouldConfirmInject` (and so `shouldAutoInject`) also refuses a body over ~15% of the context window (at a pessimistic 2.5 chars/token, same reasoning as `CAP_DENSITY_FLOOR`), and `routeSkill` excludes plan mode — a skill body there competes with the plan prompt and the progress ledger. If deterministic triggers ever prove too brittle, the escape hatch is a **fenced classifier call** (one tool-less round, descriptions only, output constrained to `<skill-name> | none`) — non-determinism quarantined in a side context that can't pollute the main window. Don't reach for a mid-loop skill tool.

## Pasted-URL expansion (`agent/pastedurls.ts`)

The user-side counterpart to URL grounding: a URL the user pastes is fetched by the harness before the turn starts and prepended as a `<url href="…">` block, structurally identical to the `<file>` block a mention produces. Same harness-drives-the-tool principle as `tools/_urls.ts`, opposite direction — there the model wrote a URL and we check it; here the user handed one over and we read it, so the content is in context whether or not a weak model would have called `fetch_url`.

Scope is the user's raw input only: URLs the model produces belong to `_urls.ts`, and URLs inside an `@mention`'d file are file content. Capped at 2 per prompt (matching the grounder) and **8k chars per URL** — tighter than the tool's 64KB payload cap because this content lands in the _user message_, which `toolcall.ts`'s fit-to-window cap does not truncate. Every fetch emits a persistent `system` receipt (an outbound request made on the user's behalf is exactly the must-see signal), and a failure distinguishes `reached` (a real dead link) from no-response (offline), same as the grounder. On by default; `REIKA_PASTE_FETCH=0` opts out.

**The trigger is the prompt's shape, not the URL's presence (#448).** A three-line error, a log line or a commit body carries links nobody meant to open, and a GET on a tracking, confirm or unsubscribe link has already acted by the time it "reads" — into the most privileged slot there is. So `isUrlTheRequest` gates the unprompted fetch on the URL being what the prompt is _about_: at most `REQUEST_MAX_WORDS` non-URL words, and the link alone (or links joined by `and`), at the start or end of a one-line prompt, or after a read verb on its own line (`read`, `look at`, `summarize`, `what does … say`; a filler or two allowed — "read this link"; `see` is deliberately absent, since "see https://… for details" is how an error ends). A multi-line prompt clears only by the verb rule: a link on the last line of a paste is the unsubscribe-at-the-bottom shape. One-directional like the skill gate — a wrong `true` is an outbound request nobody meant, a wrong `false` is one keystroke — so it under-fetches. Anything that does not clear is **asked about** in the TUI through the same two-row confirm as the skill routing (`ui/Confirm.tsx`, one dialog with two `ConfirmSpec` builders; `decidePastedUrls` sits beside `decideSkillRoute` in `App.tsx`, before the busy queue so `QueuedMessage.fetchUrls` carries the answer to the replay, and before the expansions so no fetch precedes the question); a decline leaves no receipt, since the dialog was the line. `REIKA_PASTE_FETCH` is three-valued like `REIKA_SKILL_AUTO` (`PasteFetchMode`): `ask` (default) asks in the TUI and, headless, leaves the link with an `info` receipt naming `apply`; `apply` (also `1`, which before the gate meant "fetch everything") fetches it headless while the TUI still asks; `off` fetches nothing. **The host policy follows provenance, which is now the gate's verdict rather than the paste itself:** `allowPrivate` is passed only when the URL cleared the gate or a human confirmed the fetch — "why is http://localhost:3000 500ing" asks, then fetches on a yes; a `localhost` inside a pasted trace under headless `apply` is refused by `_hosts.ts` like any harness-driven address. A URL carrying credentials (`https://user:pass@host`) is refused in every mode before any of this, with a `warn` receipt that names the host only — a fetch receipt would print the secret into the scrollback.

The fetch blocks the submit — the content has to be in the round-0 user message, so it can't be deferred — which means it needs narrating the way clipboard OCR is. `expandPastedUrls` takes an `onStart(count)` callback (it reports the count; App owns the wording) driving an `expanding` label through the same idle-state `Working` spinner as `pasting`. Since `status` is still `'idle'` until `submitToModel` flips it, `submitBusyRef` guards the window — without it a second Enter during a slow fetch starts a duplicate turn.

All three submit-time expansions (unattachable image, pasted URL, routed skill) stage their receipts on `pendingNoticesRef` instead of pushing to `messages` directly, and `submitToModel` flushes them right after the user echo. Same placement rule the URL grounder follows — a receipt is a follow-on to the action, never an announcement in front of it — and nothing can strand in the ref, since `runTurn` emits the user message unconditionally as its first act.

This is why `fetch_url` now registers unconditionally in `defaultTools`/`chatTools` while `search` stays behind `REIKA_SEARXNG_URL`: the harness puts URLs in front of the model that it must be able to follow up on, and fetching a known URL needs no provider or credential.

## Eval workflow

`npm run eval` runs all fixtures sequentially against the configured model; `npm run eval -- <substring>`
runs only matching ones, which is what you want while iterating — a local quantized model takes
minutes per fixture. `REIKA_MODEL=<id> npm run eval -- <name>` pins the model, and comparing against
a recorded result means pinning the same one (the spill fixtures were measured on `kat-coder-qq2`).
Each fixture is self-contained: `setup` files + `prompt` + `assert`. To add one:

1. New file in `evals/fixtures/NN-name.ts` exporting a `Fixture`
2. Import + add to the `FIXTURES` array in `evals/runner.ts`

Fixture `setup` files and prompts are committed source — genericize them the same way unit-test
fixtures are (see [Fixtures use generic identities](#fixtures-use-generic-identities-not-the-authors)).
An eval built from a real session is the likeliest place for a home path or a private repo name to
slip in, because the transcript it came from was real.

**Write the assertion's failure reason to be read, not just to fail.** These runs are expensive and
non-deterministic, so a bare false throws away the run: say what the model did _instead_
(`_checkerlog.ts` distinguishes "re-ran the command" from "routed around it" from "answered from
the head"), and report a correct answer reached the wrong way as exactly that. A fixture is a
record of a finding as much as a gate — several here are expected to fail and are kept for what the
failure documents (`06-grep-spill-aggregable`).

Eval timeouts use the same `AbortController` pattern as the user-side abort. Budget generously: a
capped result plus a paged artifact read runs long on a quantized model, and the 5-minute default
reports a timeout instead of an outcome.

## Things to avoid

- Re-fetching project context per-turn (defeats caching, bloats history)
- Adding a mutating tool without an approval check
- Comments that explain _what_ the code does
- Backwards-compat shims and feature flags when you can just change the code
- Multi-paragraph docstrings (keep comments to one short line max)
- Premature abstraction (three similar lines is fine; abstract when the third is genuinely the same shape)

## Cross-provider gotchas worth knowing

- A model server that is prefilling sends **zero bytes** — indistinguishable from a hang. Node's `fetch` is undici, whose 300s `headersTimeout`/`bodyTimeout` defaults would abort any turn whose prefill runs longer (issue #186: ~6.5k prompt tokens at ~23 tok/s on an M2 16GB is already over). `src/provider/dispatcher.ts` borrows the running undici's `Agent` off its global symbol — no new dependency, exact version match — and installs one with `REIKA_REQUEST_TIMEOUT_MS` on both timeouts, for the chat stream only. The default is `0` — no stream timeout (issue #382): a model streamed off SSD can be silent longer than any cap we'd pick, and Esc already cancels a server that really is hung. It fails open: if the symbol or class isn't there, you get undici's defaults back, never a crash. Stream timeouts are never retried (the prompt hasn't changed) and the error names the knob to raise.
- Reika sends no sampling params so some models may need their sampling parameters tweaked (server-side) in order to reduce issues like endless loops. Not a context bug; a single runaway completion can't be interrupted between calls. The sole exception is the experimental logit recovery (`REIKA_LOGIT_RECOVERY`), which sends a one-shot `logit_bias` on a single last-resort round only — see Loop breaking & spiral handling; normal turns still send nothing.
- The char/4 token estimate (`tokens.ts`) under-counts dense tokenizers — the context cap/compaction correct for it via a learned calibration plus a density floor on the cap (`CAP_DENSITY_FLOOR`). Don't drop the floor: it's what stops a dense tool dump overflowing before calibration catches up. Don't extend it to already-sent bytes either — see the fit-to-window cap above.
- Some cloud thinking models require `reasoning_content` to be roundtripped on assistant messages with tool_calls — handled in `src/provider/toolcall.ts`
- Strict upstreams (e.g. the validators behind OpenCode Go) 400 a few rounds in with either "The `reasoning_content` in the thinking mode must be passed back to the API" (reika pruned old reasoning below the round window) or `messages[n]: "name" is not supported by this endpoint` (reika names its tool messages). `callModel`'s degrade ladder classifies the rejection text (`shapeRejection`/`latchShapeRejection` in `src/provider/toolcall.ts`), latches the shape for the session, and re-serializes once to retry — the latch costs the reasoning round-window saving but never the turn.
- GPT-OSS on some inference engines leaks `<|channel|>` Harmony markers in tool-call names — `sanitizeToolName()` in `src/provider/client.ts` strips them defensively.
- Models without a native tool-calling template fall back to emitting calls as text; `extractToolCallsFromContent` (`client.ts`) parses the dialects (`<tool_call>{json}`, Hermes `<function=…>`, pythonic `fn(k=v)`). Thinking models sometimes leak the call into the `reasoning_content` channel instead of `content` — `callModel` recovers it from reasoning when content is empty, so the turn doesn't stall. Prefer a native template; these parsers are the fallback.
- Some chat templates hard-require a user message and raise without one (e.g. ornith-1.0-35b on llama.cpp → 400 "No user query found in messages"). Compaction folds user turns into the system recap and meta (slash-echo) turns are skipped, so a heavily-compacted long turn could otherwise send a request with no user message at all. `messagesToChatParams` guarantees one: when no user turn would be emitted it surfaces the recap as a user message instead of folding it into system (it carries the original task via `buildRecap`'s `- User:` line), with a final `(continue)` backstop if there's neither a user turn nor a recap.
