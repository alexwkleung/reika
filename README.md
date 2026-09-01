# Reika

A coding agent CLI for small local models, tuned for low quantization, with a focus on context discipline and capability alignment.

## Why

Many coding agents were specifically made for frontier/SOTA models and not intended to be optimized for local models, specifically small and low quantization ones. Whether you can only run small or heavily quantized models due to hardware or VRAM constraints, Reika attempts to fill in the gap to make them usable. The keyword specifically is usable. Not more intelligent.

In this context, "small" means roughly 8B and up: 8/9B models hold their weight and stay usable, while 14–35B is the effective sweet spot for agentic coding. Anything below 7B can work for certain narrow, well-scoped cases, but as of writing it shouldn't be considered a viable option for agentic coding.

### The Challenge

The challenges for Reika are not one particular thing but rather a series of pain points and problems:

- Understanding the least complex but an agnostic way to provide utility for low quantization and small models in an agentic coding context. There is a ceiling of course, especially in regards to intelligence which can't be fixed via the harness.
- Context management on constrained systems and models that degrade over time.
- Handling of looping and spirals.
- Harness and model ceiling constraints as they correlate with each other.

## Status

Reika is currently experimental but is stable for proper use.

---

Past:

> Initially built as a research project exploring how lean a coding agent can be while still being usable on local 3B–9B models and scaling cleanly to cloud models when needed.
>
> Started testing Reika using 8B/9B (dense), 20B (MoE), and 35B (MoE) local models with low quantization (Q2-Q4) via llama.cpp and MLX.

Now:

Mostly testing 20B-35B range models with low quantization of Q2-Q4 via llama.cpp and MLX, emphasizing on the limits of 30B-35B models on constrained hardware to achieve viability in agentic coding (to some extent).

## Note

Although Reika can work with small and low quantization models, the output and quality will vary during agentic coding compared to pure chat.

## Tested Models

- Qwen3.8 27B (UD-IQ3_XXS)
- Qwen3.6 35B A3B (UD-IQ2_M)
- Qwen3.6 35B A3B (UD-IQ2_XXS)
- Ornith 1.0 35B (UD-IQ2_M)
- Laguna XS 2.1 (IQ2_M)
- KAT Coder V2.5 Dev (IQ2_M)
- North Mini Code 1.0 (UD-IQ3_XXS)
- Gemma 4 26B A4B IT (UD-IQ3_XXS)
- GPT-OSS 20B (MXFP4-Q4)
- Ornith 1.5 9B (Q5_K_M)
- Qwen3.5 9B (MLX Q4)
- LFM2.5 8B A1B (MLX Q4)
- Granite 4.1 8B (MLX Q4)

## Quick start

```sh
npm install
cp .env.example .env
# edit .env to point at your model
npm run dev
```

Reika sends no sampling parameters of its own, so `llama-server` flags
or your provider's defaults are what actually apply.

## Global install

```sh
npm run install:global     # builds + installs the `reika` binary globally
npm run uninstall:global   # removes it
```

After global install, `reika` is on your `$PATH`. Run it from any project directory.

## Configuration

Config sources, in precedence order (higher wins):

1. **Shell env vars** (e.g. `export REIKA_MODEL=qwen3.5-9b` in `~/.zshrc`).
2. **Project `.env`** (cwd where you run `reika`) — per-project overrides.
3. **Global `~/.config/reika/.env`** — defaults for a global install.

`.env` keys. The **Default** column is what Reika uses when the key is unset;
[`.env.example`](.env.example) is a tuned starting point, not a copy of those defaults, and
deliberately ships larger values for a few keys — `REIKA_MAX_TURNS=500`,
`REIKA_SUBAGENT_MAX_TURNS=500`, `REIKA_REPO_MAP_BUDGET=6000`, `REIKA_CONTEXT_WINDOW=24000`,
`REIKA_MIN_GEN_TOKENS=6144` — sized for a reasoning-on local model with room to work rather
than for the smallest safe fallback. Trim them for a tiny model or a tight window.

| Key                           | Default                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REIKA_BASE_URL`              | `http://localhost:11434/v1`         | OpenAI-compatible endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REIKA_MODEL`                 | _required_                          | Model name, or a comma-separated list of models served by the same `REIKA_BASE_URL`. First is the default; switch with `/model <name>`                                                                                                                                                                                                                                                                                                                                                                                         |
| `REIKA_API_KEY`               | `no-key`                            | Cloud API key (any non-empty for local)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `REIKA_MAX_TURNS`             | `12`                                | Tool-call iterations per user turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `REIKA_REPO_MAP_BUDGET`       | `3200`                              | Chars allotted to repo map in system prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REIKA_AUTO_APPROVE`          | `off`                               | Approval mode. `safe` (or `true`/`1`) auto-approves edit/write/bash but still prompts for dangerous commands and for any write that lands outside the project directory; `bypass` (or `yolo`) skips all prompts, and refuses out-of-project writes outright since there is no prompt to fall back on; `off` (the default, and what any unrecognized value such as `false` resolves to) confirms everything                                                                                                                     |
| `REIKA_DEFAULT_MODE`          | `agent`                             | Mode the session starts in: `agent`, `plan`, or `vibe` (chat/shell aren't launchable defaults). Unrecognized values fall back to `agent`. `REIKA_PLAN_EXPERIMENT=1` is the legacy alias for `plan`; an explicit `REIKA_DEFAULT_MODE` wins                                                                                                                                                                                                                                                                                      |
| `REIKA_SUBAGENT_MODEL`        | _falls back to main_                | Override model for subagents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REIKA_SUBAGENT_BASE_URL`     | _falls back_                        | Override server for subagents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `REIKA_SUBAGENT_API_KEY`      | _falls back_                        | Override key for subagents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REIKA_SUBAGENT_MAX_TURNS`    | `6`                                 | Subagent iteration limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `REIKA_MAX_TOKENS`            | _unset_                             | Cap response tokens per call (cloud cost/latency control). Per-profile override available                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REIKA_CONTEXT_WINDOW`        | _unset_                             | Model context window; denominator for the status-line `ctx` fill gauge. Per-profile override available. Unset shows absolute tokens, no %                                                                                                                                                                                                                                                                                                                                                                                      |
| `REIKA_MIN_GEN_TOKENS`        | `2048`                              | Generation room reserved from the window. Drives the per-turn `max_tokens` backstop, the payload cap reserve, and the compaction trigger. Per-profile override. ~2048 reasoning-off; 6144–8192 reasoning-on (set 6144 on a 16k thinking model). Needs `REIKA_CONTEXT_WINDOW`                                                                                                                                                                                                                                                   |
| `REIKA_REASONING_ROUNDS`      | `2`                                 | Recent tool-call rounds that keep their reasoning in context (rest pruned). 1 = leanest; higher avoids re-derivation on thinking models, at a token cost                                                                                                                                                                                                                                                                                                                                                                       |
| `REIKA_PROFILES`              | _unset_                             | Comma-separated names of extra profiles, each defined by `REIKA_<NAME>_MODEL` / `_BASE_URL` / `_API_KEY` (plus optional `_MAX_TOKENS` / `_CONTEXT_WINDOW` / `_MIN_GEN_TOKENS`). For a model behind a different endpoint or key — see [Multiple models](#multiple-models)                                                                                                                                                                                                                                                       |
| `REIKA_SEARXNG_URL`           | _unset_                             | SearXNG instance URL (self-hosted, local-first); enables the `search` tool. `fetch_url` registers regardless                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REIKA_PASTE_FETCH`           | `1`                                 | Fetch `http(s)` URLs pasted into a prompt before the turn runs (up to 2, 8k chars each). `0` disables — an outbound request per pasted link                                                                                                                                                                                                                                                                                                                                                                                    |
| `REIKA_ASK`                   | `1`                                 | The `ask_user` tool: the model can put one multiple-choice question to you mid-turn instead of guessing when what it read contradicts what you asked for. `0` removes the tool, and with it the agent prompt's line about asking                                                                                                                                                                                                                                                                                               |
| `REIKA_MAX_SEARCHES_PER_TURN` | `3`                                 | Cap `search` calls per user turn (prevents runaway / quota burn)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REIKA_MAX_FETCHES_PER_TURN`  | `5`                                 | Cap `fetch_url` calls per user turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `REIKA_BASH_TIMEOUT_MS`       | `300000`                            | Wall-clock timeout for a single bash command, ms (raise for slow builds, lower to fail hangs faster)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REIKA_REQUEST_TIMEOUT_MS`    | `1800000`                           | How long the model server may send **nothing at all** before the request is aborted, ms. Covers prefill: llama.cpp emits no bytes while it processes the prompt, and Node's own default would kill the turn at 300s (~6.5k tokens on slow local hardware). `0` waits indefinitely                                                                                                                                                                                                                                              |
| `REIKA_OCR_LANGS`             | _unset_                             | Preferred languages (BCP-47, comma-separated) for OCR of pasted images, e.g. `en-US,ja-JP`. Unset uses the platform recognizer's default. Windows uses only the first entry                                                                                                                                                                                                                                                                                                                                                    |
| `REIKA_SKILLS_DIR`            | `~/.config/reika/skills`            | Directory of `*.md` skill files, each of which becomes a slash command. `<cwd>/.reika/skills/` shadows it on name collision — see [Skills](#skills-reusable-prompt-templates)                                                                                                                                                                                                                                                                                                                                                  |
| `REIKA_TSCONFIG`              | _unset_                             | Override the tsconfig the post-edit typecheck gate uses (relative to cwd or absolute). For layouts auto-detection can't reason about — references-only roots, or named-variant-only projects (`tsconfig.web.json`, …) with no plain `tsconfig.json`. Normally auto-detected: walks up from the edited file to the nearest `tsconfig.json`                                                                                                                                                                                      |
| `REIKA_DEBUG`                 | _unset_                             | Any non-empty value writes diagnostics (session-start bundle size, loop/spiral detectors, grounding, prefix-cache classification with the prefill cost it implies, per-round entropy/KL drift, etc.) to a log file. Goes to a **file**, never stderr — stderr would corrupt the Ink TUI frame                                                                                                                                                                                                                                  |
| `REIKA_DEBUG_FILE`            | `~/reika-debug.log`                 | Path for the `REIKA_DEBUG` log. The default log is reset at the start of each session; an explicit `REIKA_DEBUG_FILE` is always appended to, so use it when an experiment should accumulate across runs                                                                                                                                                                                                                                                                                                                        |
| `REIKA_ENTROPY`               | _unset_                             | `1` asks the server for per-token logprobs, so the `REIKA_DEBUG` drift lines report the model's real predictive entropy (and how surprised it was by its own output) instead of the entropy of the text alone. Needs `REIKA_DEBUG` — the log is the only consumer — and costs a much larger streamed response (top-5 candidates per token). The per-round entropy/KL lines are written either way; this only sharpens the entropy half. A server that rejects the fields is retried once without them, so it can't cost a turn |
| `REIKA_SPILL_STATS`           | _unset_                             | `1` appends one JSON line per over-cap tool result — and per call that opens a saved artifact — to a stats file. Sizes and tool names only, never output. Measurement, not a feature: an eval can show the model follows a locator, but only real use answers what share of your `bash` calls exceed the 64KB cap at all, which is what decides whether the retained window is sized right. Off by default; no behavior change while it runs                                                                                   |
| `REIKA_SPILL_STATS_FILE`      | `~/.config/reika/spill-stats.jsonl` | Path for the `REIKA_SPILL_STATS` file. Always appended to — unlike the debug log, it is meant to accumulate across sessions                                                                                                                                                                                                                                                                                                                                                                                                    |

## Experimental flags

Feature-flagged subsystems, all **off by default** in code (set to `1` to enable), being trialled before becoming default. [`.env.example`](.env.example) turns on every flag in the table below except `REIKA_ANON`: for now they are worth enabling for a better experience, and they become default once further tested. See the "Loop breaking & spiral handling" / "Modes" / "Context management" sections of [`AGENTS.md`](AGENTS.md) for the full rationale. They mostly matter for small/quantized local models; on a strong cloud model they're low-value (and a couple cost a little).

| Key                    | What `1` does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REIKA_PLAN_HANDOFF`   | Folds the plan-mode exploration transcript into a single digest at the plan→agent boundary (`distillPlanHandoff`), keeping the original request and the written plan verbatim — so on a small window the raw read payloads and reasoning from planning don't crowd out the agent's own loop and let the plan decay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `REIKA_PLAN_VERIFY`    | Grounds a finalized plan against the codebase: paths and backticked identifiers it names are checked (paths by `stat`, symbols by a bounded tree walk) and any not found are appended as a "may be new" advisory the agent turn inherits — heading off the agent hunting on 0-match greps or edits whose `old_string` is in no file. Advisory only, one-directional (under-flags rather than over-flags)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REIKA_PLAN_ALIGN`     | Plan-alignment pressure on top of the (always-on) step checklist: the checklist is pinned into the system prompt each round during implementation, and a turn that stops with observable steps unchecked is bounced back once (leftovers are then waived, not re-asked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `REIKA_PLAN_BASH`      | Gives plan/vibe mode a **read-only** `bash`: commands a strict allowlist classifier can prove read-only (`grep`/`cat`/`head`/`find`/`wc`/… and pipelines of them) run; anything that could write or run something else — redirection, command substitution, `sed`/`awk`, any unlisted command — is refused with the rule stated. Plan mode still cannot mutate the repo; the guarantee moves from the tool's absence to the classifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `REIKA_READ_FIRST`     | Read-first edit gate: while implementing a written plan, the first `edit` to a file the model hasn't read this turn is held back once with a directive to read it, preventing blind edits from failing on `old_string` mismatches. Fail-open — re-issuing the edit applies it as-is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REIKA_REASONING_LOOP` | Acts on detected reasoning rumination (the model re-deriving the same analysis across rounds while tool results look new; measured over 8-gram self-repeat + cross-round similarity): plan mode gains a force-write trigger, agent mode drives the nudge→ledger→withdrawal ladder. Detection always runs and feeds the debug line; only the action is gated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `REIKA_VERBATIM_ABORT` | Cuts a single runaway reasoning block mid-stream — on a length-aware self-repeat ratio, or an absolute length ceiling for low-repetition semantic spirals — instead of letting it run to the `max_tokens` wall; recovery is by mode (plan → force-write, agent → nudge). The only pre-cap backstop for a never-ending single block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `REIKA_LOGIT_RECOVERY` | Spends one last-resort biased round before the terminal reasoning-loop stop: a mild one-shot `logit_bias` (−4, capped, tool-name tokens exempt) down-weighting the loop's own recurring tokens. llama.cpp-only (needs the native `/tokenize` endpoint) and only active when `REIKA_REASONING_LOOP` is also on; degrades to the honest stop if it doesn't help                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REIKA_CONVERGE_RETRY` | Inserts one steered retry before the honest give-up stop (plan and agent): a strong, failure-naming directive ("you looped and kept re-questioning yourself; commit to one analysis and do it") instead of a cold stop. Capped at one; worst case is unchanged — the same stop fires once the budget is spent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REIKA_URL_GROUNDING`  | Fetches http(s) URLs a write/edit (or a finalized plan) introduces, on the model's behalf, and appends a ✓/✗ receipt — catching a plausible-but-wrong link that would otherwise fail silently at runtime. Mirrors the dep grounder: capped (2/call), per-turn deduped, offline-safe (a no-response URL is called dead only when another URL in the batch proved connectivity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REIKA_SPILL`          | Saves an over-cap `grep`/`glob`/`bash` result to a session-scoped temp file and appends the path to the inline page, so the bytes the cap drops stay reachable — the model pages the file with `read`/`grep` instead of re-running the search or the command. Adds no tool and no schema; the locator points at tools the model already has. Fail-open (a spill that can't be written leaves the ordinary capped result) and a strict no-op when off. `bash` is the case where the _end_ is what matters — it stopped draining at the cap, so a long build or test run lost the failure at the end of it; the payload keeps the head and a bounded 4MB window keeps the tail. Benched on a 2300-file monorepo, where `**/*.ts` matched 560 files whose 200-path page covered 3 of 5 packages — the concentration a small repo never reveals, since a cap it cannot reach behaves identically to the flag being off |
| `REIKA_SKILL_AUTO`     | Lets a strongly-matched skill (two `triggers`, or one multi-word phrase) prepend its body to your prompt instead of only being suggested, with a scrollback receipt naming the matched phrases. Selection is deterministic — the model never picks. Refused when the body exceeds ~15% of the context window, and never in plan mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REIKA_WARM`           | Speculative KV-cache warming: the first keystroke of a prompt fires a throwaway 1-token request carrying the exact prefix the submit will send (system + history), so a llama.cpp-style server prefills its cache in the typing gap and the real request re-processes only the user message. Fail-open; skipped when the next turn would compact. Best on slow-prefill local setups; a needless (tiny) cost on paid APIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `REIKA_DEDUP_PAYLOADS` | Replaces older duplicate tool-result payloads in the request with a short stub to reclaim context (`toolcall.ts`). Bypassed while `REIKA_PREFIX_STABLE` is on — a stub flipping on a later duplicate would rewrite mid-history bytes and invalidate the prefix cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REIKA_PREFIX_STABLE`  | Keeps requests append-only between context-shrink events so the inference engine's prompt-prefix cache stays valid: tool payloads stay live and age in one batch at the compaction threshold instead of every round, and loop/plan nudges ride a trailing note instead of the system prompt. Cuts per-round prompt re-processing on llama.cpp (SWA/hybrid-memory models especially, which re-process the whole prompt on any prefix change), at the cost of a fuller context between events. Needs `REIKA_CONTEXT_WINDOW`; takes precedence over `REIKA_DEDUP_PAYLOADS`                                                                                                                                                                                                                                                                                                                                            |
| `REIKA_ANON`           | Replaces your own git author name/email and your GitHub/GitLab/HuggingFace account slug with `<user>`/`<email>` in the scrollback and in saved transcripts, for screenshots and shared logs. Identity is looked up once at startup (git config, remotes, and the author lines in recent commits) and substituted as literals — third-party owners like `anthropics/` or `Qwen/` are untouched, because a pattern sweep over `owner/repo` cannot tell yours from theirs. Display only: the model still receives everything verbatim                                                                                                                                                                                                                                                                                                                                                                                 |

## Multiple models

There are two ways to expose more than one model, and they compose.

**Same base URL (e.g. a model router).** Just list the models in `REIKA_MODEL`, comma-separated. They all share `REIKA_BASE_URL`/`REIKA_API_KEY`; the first is the default, and the rest are switchable with `/model <name>` — no extra env vars to add or remove as your router's catalogue changes:

```ini
REIKA_BASE_URL=http://localhost:8080/v1
REIKA_MODEL=qwen3-coder,kimi-k2,glm-4.6   # /model kimi-k2 to switch
```

**Different endpoints/keys — named profiles.** When a model lives behind a different base URL or API key, define a full profile and switch between them at runtime with `/model <name>`:

```ini
# Default profile (existing keys — always available as "default")
REIKA_MODEL=qwen3.5-9b
REIKA_BASE_URL=http://localhost:8080/v1
REIKA_API_KEY=no-key

# Additional named profiles — list them, then define each
REIKA_PROFILES=kimi,gpt
REIKA_KIMI_MODEL=kimi-k2.6
REIKA_KIMI_BASE_URL=https://api.moonshot.ai/v1
REIKA_KIMI_API_KEY=sk-...
REIKA_KIMI_MAX_TOKENS=16384         # reasoning models need headroom
REIKA_KIMI_CONTEXT_WINDOW=262144    # drives the ctx fill gauge for this profile
REIKA_KIMI_MIN_GEN_TOKENS=8192      # generation reserve; raise for reasoning models
REIKA_GPT_MODEL=gpt-5.4-mini
REIKA_GPT_BASE_URL=https://api.openai.com/v1
REIKA_GPT_API_KEY=sk-...
REIKA_GPT_MAX_TOKENS=4096
```

Per-profile `_MAX_TOKENS`, `_CONTEXT_WINDOW`, and `_MIN_GEN_TOKENS` fall back to the corresponding global defaults if unset. When a context window is known, `max_tokens` is computed per turn as the room actually left (`window − prompt − margin`), capped by `REIKA_MAX_TOKENS` if you set one — so you usually don't need to set `_MAX_TOKENS` at all; size `_MIN_GEN_TOKENS` instead to reserve think-room. If you _do_ pin `_MAX_TOKENS`, **set it generously** — a value low enough to truncate mid-JSON breaks tool calls silently, and reasoning models (DeepSeek-R1, Kimi K2) need extra headroom since the thinking phase counts toward the cap.

Then in-session:

- `/model` — show the current selection and list available models (default base URL) and named profiles
- `/model kimi-k2` — switch to a model on the default base URL (model name only swaps)
- `/model kimi` — switch to a named profile (model + endpoint + key swap as a unit)
- `/model some-new-model` — a name that isn't in your config still switches: it rides the current base URL/key, so you can test a model without touching `.env`. The switch message and picker flag it as `(not in config)`
- `/new` — resets to default

Conversation history persists across switches; if styles clash, run `/new` first. Token counter accumulates across models/profiles for a single session bill.

## Tools

The agent has these tools. Optional tools register only when their config is present:

| Tool        | What                                                                  | Approval?               | Optional?                    |
| ----------- | --------------------------------------------------------------------- | ----------------------- | ---------------------------- |
| `read`      | Read lines from a file (line-ranged, default 200 lines)               | no                      | —                            |
| `list`      | List files in a directory (depth-limited)                             | no                      | —                            |
| `grep`      | JS regex over file contents (cap 100 matches)                         | no                      | —                            |
| `glob`      | Find files by path pattern (e.g. `**/*.ts`); no content reading       | no                      | —                            |
| `edit`      | Strict find-and-replace; one-occurrence, fails on missing/multiple    | yes                     | —                            |
| `write`     | Create a new file; refuses to overwrite                               | yes                     | —                            |
| `bash`      | Run a shell command (streamed output, danger-pattern warnings)        | yes                     | —                            |
| `subagent`  | Spawn an isolated subagent for focused exploration                    | no (its own tools may)  | —                            |
| `search`    | Web search (returns title + URL + snippet, up to 8)                   | no                      | requires `REIKA_SEARXNG_URL` |
| `fetch_url` | Fetch a URL, extract main content as markdown (defuddle)              | no                      | always registered            |
| `ask_user`  | Ask you ONE multiple-choice question mid-turn and wait for the answer | no (it _is_ the prompt) | `REIKA_ASK=0` removes it     |

Approval prompts show a unified diff (or the command for `bash`), with `Approve / Decline / Always (this session)` selectable by `↑↓` + `Enter` or by direct `y`/`n` shortcut.

`ask_user` renders the same way: `↑↓` + `Enter` to pick an option, `Tab` to pick one _and_ add a note in your own words, or select the last row — always present — to type your own answer instead, when none of the options is the right frame. One question per turn, and the answer is pinned into context afterwards so it can't be forgotten and re-asked later in the same turn. Small models can and do frame a question around a misreading, so the options are not a summary of the request; that last row is the way out.

## Skills (reusable prompt templates)

Drop a `*.md` file in a skills directory and it becomes a slash command. Useful for saved workflows (`/review`, `/deploy`, `/refactor`, etc.).

**Locations (project shadows global on name collision):**

- Global: `$REIKA_SKILLS_DIR` if set, otherwise `~/.config/reika/skills/`
- Project: `<cwd>/.reika/skills/`

**Layouts (both supported):**

- **Flat file:** `~/.config/reika/skills/review.md` → `/review`
- **Directory with `SKILL.md`:** `~/.config/reika/skills/review/SKILL.md` → `/review`. Lets a skill carry supporting files (scripts, reference docs) — only `SKILL.md` is used as the prompt body; other files are ignored. Matches the Claude Code skill packaging convention, so you can drop skill folders in verbatim.

**File format** — plain markdown with optional YAML frontmatter. Example below:

```md
---
description: Review the current branch end-to-end
triggers: review the branch, code review, look over my changes
---

Review the changes on this branch:

1. Run git diff main...HEAD
2. Check for missing tests on changed code
3. Check for inconsistencies with AGENTS.md
   Report a punch list.
```

Without frontmatter, the first non-empty line becomes the autocomplete description; the whole file is the prompt body.

**Invocation:**

- `/review` — sends the file body as your input
- `/review focus on the API changes` — appends extra args to the body, separated by a blank line
- `/skills` — list available skills

### Plain-English routing (`triggers`)

You don't have to remember the slash command. `triggers:` lists phrases that route an ordinary prompt to the skill — matched **deterministically in the harness**, never by the model. Writing "review the branch for me" gets you a one-line hint that `/review` exists; the turn runs normally either way.

The frontmatter accepts any YAML list shape (`triggers: a, b`, `triggers: [a, b]`, or a `- ` block list). The skill's own name is always an implicit trigger, so a skill called `verify` routes "verify my changes" with no `triggers:` at all.

Matching rules, in short:

- Whole-word only — a skill named `test` does not fire on "latest"
- Multi-word phrases score higher than single words; phrases under 3 characters are ignored
- A tie between two skills suggests neither (routing by array order would be arbitrary)
- Continuations (`yes`, `ok`, `continue`, `do it`, …) never route
- A skill is suggested at most once per session — decline it once and it stops asking

**Auto-run (`REIKA_SKILL_AUTO=1`, experimental, off by default):** on a strong match — two triggers, or one multi-word phrase — the skill body is prepended to your prompt instead of just being suggested, with a scrollback receipt naming which phrases matched. Refused when the body would take more than ~15% of the context window, and never in plan mode (a skill body there competes with the plan prompt and progress ledger).

### Pasted URLs

Paste an `http(s)` link into a prompt and Reika fetches it before the turn starts, prepending the extracted content as a `<url href="…">` block — the same mechanism as `@file` mentions, so the model reads the page instead of guessing at it. Up to 2 URLs per prompt, truncated to 8k characters each (`fetch_url` gets the rest). Every fetch leaves a scrollback line, and a dead link is reported as one rather than silently dropped. Set `REIKA_PASTE_FETCH=0` to turn it off — worth doing on an airgapped machine.

Only URLs _you_ type are fetched. Links inside an `@`-mentioned file are file content, and links the model writes are handled separately by URL grounding (`REIKA_URL_GROUNDING`).

**Rules:**

- Built-in commands always win over skills with the same name — you can't shadow `/help` or `/exit`
- Skill names are lowercased filenames; only `[a-z0-9_-]` are accepted (skip files with weird names)
- Skills load at bootstrap and on `/cd` — edit a file mid-session, then `/cd .` to refresh
- Files under `<cwd>/.reika/` (including `.reika/skills/`, `.reika/handoff/`, etc.) appear in `@` autocomplete — handy for inlining a project-local handoff doc, an in-repo skill file, or any other Reika-scratch content. Other dot-dirs (`.git/`, `.vscode/`, etc.) stay hidden.

## Modes

`Shift+Tab` cycles through them (agent → plan → vibe → chat → shell), or switch directly with the slash commands below.

- **Agent** (default): input goes to the model; it can call tools
- **Shell**: `/shell` to enter — input runs as bash directly (no model, no approval), output streams to scrollback. `/agent` returns.
- **Chat**: `/chat` to enter — pure chat with the model. No filesystem/shell tools registered (only `search` and `fetch_url` if configured). Conversation history is fully isolated from agent mode — switching back and forth keeps each side's history independent. `/agent` returns. Status bar shows a `chat` tag when active.
- **Plan**: `/plan` to enter — read-only exploration. Only `read`/`list`/`grep`/`glob` are registered (no `edit`/`write`/`bash`), so the model can't change anything; it explores and ends by writing a numbered, file-specific plan. Unlike chat, history is **shared** with agent mode, so the flow is `/plan` → it writes the plan → `/implement` (or `/agent` then a prompt) to execute it with the plan already in context. `REIKA_DEFAULT_MODE=plan` (or the legacy `REIKA_PLAN_EXPERIMENT=1`) starts the session in plan mode. `/agent` returns. Status bar shows a `plan` tag when active.
  - **Plan checklist**: while a written plan is being implemented, the UI shows its numbered steps as a live checklist and checks steps off from harness-observed facts — never the model's own claim of progress. Three deterministic signals: a successful `edit`/`write` to a file the step names; a step-quoted code snippet appearing in a successful edit's diff (so a plan that names the wrong file still checks off when the model edits the right one — the receipt says so); and a successful (exit-0) `bash` run containing the step's quoted command (so "run typecheck/tests" steps complete). Progress is recomputed from history each turn, so it survives across turns. Steps with none of these signals display but can't auto-check.
  - `REIKA_PLAN_ALIGN=1` (experimental) adds model-facing pressure on top of the tracking: the checklist rides the system prompt every round of an implementing turn (so the plan can't age out of context), and a turn that tries to finish with observable steps unchecked is sent back once with the unfinished steps quoted. If it finishes anyway, the leftovers are marked waived (`~`) — adjudicated once, never re-asked on later turns.
  - `REIKA_READ_FIRST=1` (experimental) prevents blind edits during implementation: the first `edit` to a file with no `read` (or prior successful edit/write) this turn is withheld once, with a directive to read the file and re-issue the edit from its actual bytes — reading first instead of reasoning about an `old_string` failure after the fact. One bounce per file per turn; a re-issued edit always runs.
  - `REIKA_PLAN_BASH=1` (experimental) registers a read-only `bash` in plan (and vibe) mode, for the inspection a pipeline expresses that `read`/`grep`/`glob`/`list` cannot — `grep … | head`, `find`, `wc -l`. A strict allowlist classifier (`tools/_readonly.ts`) decides: only listed inspection commands and pipelines of them run, and redirection, command substitution, `sed`/`awk` and anything unlisted are refused with the rule and the way out stated in the result. It runs without an approval prompt — the classifier has proved the command cannot mutate anything, and plan mode's other four tools already read arbitrary paths silently — while the ordinary `bash` in agent mode prompts exactly as before. The plan system prompt tracks the flag, so it stops claiming commands will fail.
- **Vibe**: `/vibe` to enter — the full plan→implement pipeline on every prompt. Each prompt first runs as a plan-mode turn (read-only tools, same convergence machinery), and if it ends with a written plan, the plan is implemented immediately as a normal agent turn — no `/implement` needed. A plan phase that is aborted (ctrl-c) or dead-ends without a plan stops there; nothing chains. Approvals are untouched: the implement phase prompts for edits and commands exactly like agent mode, so `REIKA_AUTO_APPROVE` / `/approvals` remain the only things that change what auto-runs. Probably not the mode for maximum quality — it exists to watch a local model go end-to-end on its own. `REIKA_DEFAULT_MODE=vibe` starts the session in vibe mode. `/agent` returns. Status bar shows a `vibe` tag when active.

## Slash commands

Type `/` in the input to see suggestions. Highlights:

| Command                                           | What                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                                           | List all commands                                                                                                               |
| `/new` / `/clear`                                 | Reset conversation, tokens, mode                                                                                                |
| `/cd <path>`                                      | Change cwd (re-indexes repo map). Tilde works.                                                                                  |
| `/shell` / `/chat` / `/plan` / `/vibe` / `/agent` | Switch modes (shell / chat / plan / vibe / back to agent)                                                                       |
| `/implement [guidance]`                           | From plan mode: switch to agent and execute the plan above (optional guidance)                                                  |
| `/model` / `/cwd` / `/tokens`                     | Show current values                                                                                                             |
| `/approvals [on\|off]`                            | Show or toggle session auto-approve. `REIKA_AUTO_APPROVE` env var still wins.                                                   |
| `/stats`                                          | Full session summary (duration, turns, tools, files modified, approvals)                                                        |
| `/save [--raw]`                                   | Save the full conversation to `~/.config/reika/history` (`.jsonl` + `.txt`). Secrets are redacted; `--raw` keeps them verbatim. |
| `/skills`                                         | List available skills (loaded from skill dirs at startup)                                                                       |
| `/exit` / `/quit`                                 | Exit (prints session summary first)                                                                                             |
| `@<path>`                                         | In agent mode, inlines a file as context. Tab autocomplete from the file index.                                                 |

A saved transcript records mode alongside the conversation: each turn is labelled with the mode it ran in (`You [plan]:`, and `mode` on the JSONL record), and the header carries the mode at save time plus the whole arc — `# modes: agent (turns 1-3) → plan (turn 4) → agent (turn 5)`. A vibe turn is recorded as `vibe`, not as the plan and agent phases it runs as internally. So a transcript says how the work was done, not just what was said.

The header also freezes the status line's accounting at save time — turn count, session tokens sent and received, current context against the window, and how much of the last prompt came from cache — so a shared transcript carries the numbers without the footer pasted beside it:

```
# turns:    7
# tokens:   1.3M↑ 34k↓ (session total, 900k from cache)
# ctx:      45k/128k (35%)
# cache:    89% of the last prompt (40k)
```

Anything unreported is left out rather than written as zero: a provider that reports no cache hits gets no cache line at all, and a context size recorded before the first call lands is marked `(estimated)`. The same numbers ride the JSONL meta record under `usage`.

## Scripts

- `npm run dev` — run the CLI with `tsx`
- `npm run build` — compile TS to `dist/`
- `npm run typecheck` — TypeScript only
- `npm run lint` / `lint:fix`
- `npm run format` / `format:check`
- `npm test` / `test:watch` — vitest unit tests
- `npm run check` — typecheck + lint + format:check + test (use before committing)
- `npm run eval` — run the eval suite against the configured model

## Architecture

The big ideas:

- **Bootstrap once.** `bundle.cwd`, `bundle.repoMap`, `bundle.fileIndex`, AGENTS.md, project summary are all built once at startup and kept stable across turns. Critical for prompt caching at the provider.
- **Payload aging.** Tool results carry `summary` + `payload`. Only the latest contiguous block of tool results sends `payload` to the model; older ones collapse to `summary`-only. Keeps history token-bounded without losing information the model just acted on.
- **Single system-prompt builder.** Parameterized; no duplication across modes.
- **OpenAI-compatible end-to-end.** Local inference engines and cloud providers all work.
- **Streaming, abort, approval, subagent** all flow through one `AbortController` and one set of callbacks.

There's more that isn't covered.

## Design philosophy

Reika was initially designed around small models, so the source code itself reflects the shape and constraints when using them in a coding agent.

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) so the model sees both in one directory scan
- **One concept per file, shallow directory depth** so a unit fits in a single read
- **Predictable file shapes within a category** (every tool follows the same `Tool` shape) so the pattern is learned once
- **Names that read like sentences** so identifiers reduce the need for explanatory comments
- **Comments only for WHY, never WHAT** — the model already reads what
- **Light on abstraction** — direct code beats three-layer indirection at small-model scales; "rule of three" becomes more like "rule of five"

When the reader is an LLM with a token budget, the case for locality, predictability, and explicit naming gets stronger; the case for clever abstraction gets weaker. See `AGENTS.md` for the longer version.

## Working caveats

- Approval slows multi-edit sessions. Set `REIKA_AUTO_APPROVE=safe` (or `true`) for trusted runs: ordinary edits/commands auto-run, but commands matching a dangerous pattern (`rm -rf`, force push, any package install/uninstall, `npx`, `curl`/`wget`, `pkill`/`killall`, etc.) still force a manual approve/reject. This is yolo mode with safeguards. For true no-prompts-ever, set `REIKA_AUTO_APPROVE=bypass` (or `yolo`) — that runs dangerous commands without asking.
- Subagent quality depends entirely on the model; small models often _cost_ turns rather than save them. Furthermore, the subagent will only run if its configured.
- The repo map and file index don't auto-refresh after external file changes — `/cd .` re-indexes.
- Cmd+←/→ on macOS depends on terminal config; Ctrl+A/E always works.
- Image paste (ctrl-v) runs the image through the OS text recognizer, so it works with any model — including text-only ones. It needs `@napi-rs/system-ocr`, which ships prebuilt binaries for macOS and Windows only; on Linux the paste reports that OCR is unavailable rather than failing. It extracts _text_, so a screenshot of a stack trace or an error dialog works well and a screenshot of a UI mockup does not.
- Tool calling is most reliable when the model is served with its **native function-calling chat template**. Without one, models fall back to emitting tool calls as text — Reika parses the common dialects (`<tool_call>{json}</tool_call>`, Hermes `<function=…>`, pythonic `fn(k=v)`, and calls leaked into the reasoning channel) as a best-effort fallback, but the native path avoids the malformed/looping/leaked calls those fallbacks exist to catch. If a local model misbehaves on tool use, first check that your server (llama.cpp / Ollama / vLLM / MLX) loads a tools-enabled template for it.

There's more that isn't covered.

## `.gitignore` is respected

`buildFileIndex`, `buildRepoMap`, `list`, and `grep` all skip paths matched by your project's `.gitignore` (plus `.git/info/exclude`). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply on top — so even projects without a `.gitignore` get sensible exclusions.

## Inspired by

Inspired by Claude Code, Codex, Crush, OpenCode, Pi, DeepSeek Harness, Qwen Code, Kimi Code CLI, and Gemini CLI.
