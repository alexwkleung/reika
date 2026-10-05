# Configuration

[← README](../README.md)

Config sources, in precedence order (higher wins):

1. **Shell env vars** (e.g. `export REIKA_MODEL=qwen3.5-9b` in `~/.zshrc`).
2. **Project `.env`** (cwd where you run `reika`) — per-project overrides.
3. **Global `~/.config/reika/.env`** — defaults for a global install.

The keys are grouped by area below. In each table, the **Default** column is what Reika uses when the key is unset;
[`.env.example`](../.env.example) is a tuned starting point, not a copy of those defaults, and
deliberately ships larger values for a few keys, sized for a reasoning-on local model with room
to work rather than for the smallest safe fallback. Trim them for a tiny model or a tight window.

## Endpoint, models and profiles

| Key                  | Default                    | What                                                                                                                                                                            |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_BASE_URL`     | `http://localhost:8080/v1` | OpenAI-compatible endpoint                                                                                                                                                      |
| `REIKA_MODEL`        | _required_                 | Model name, or a comma-separated list of models served by the same `REIKA_BASE_URL`.                                                                                            |
| `REIKA_API_KEY`      | `no-key`                   | Cloud API key (any non-empty for local)                                                                                                                                         |
| `REIKA_PROFILES`     | _unset_                    | Comma-separated names of extra profiles, each defined by `REIKA_<NAME>_MODEL` / `_BASE_URL` / `_API_KEY` (plus optional `_MAX_TOKENS` / `_CONTEXT_WINDOW` / `_MIN_GEN_TOKENS`). |
| `REIKA_MODE_MODELS`  | _unset_                    | Model each mode runs on, as `<mode>=<model\|profile>` pairs: `plan=kimi,grind=qwen3-coder`.                                                                                     |
| `REIKA_DEFAULT_MODE` | `agent`                    | Mode the session starts in: `agent`, `plan`, `vibe`, `minimal`, or `grind` (chat/shell aren't launchable defaults).                                                             |

- **`REIKA_MODEL`** — First is the default; switch with `/model <name>`
- **`REIKA_PROFILES`** — For a model behind a different endpoint or key — see [Multiple
  models](#multiple-models)
- **`REIKA_MODE_MODELS`** — The mode a turn runs in picks the model — at startup and on every mode
  switch, outranking the profile the last session saved. A mode with no entry runs the session's own
  model, so leaving a mapped mode comes back to it. A `/model` you pick by hand outranks the map for
  the rest of the session (and `/new` clears that). Values are profile names or `REIKA_MODEL`
  models; an entry naming neither is ignored with a startup line. `shell` runs no model and is not a
  mode here. See [Per-mode models](#per-mode-models)
- **`REIKA_DEFAULT_MODE`** — Unrecognized values fall back to `agent`. `REIKA_PLAN_EXPERIMENT=1`
  is the legacy alias for `plan`; an explicit `REIKA_DEFAULT_MODE` wins

## Context, generation and limits

| Key                      | Default                 | What                                                                                                                                                                                                                         |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_CONTEXT_WINDOW`   | _unset_                 | Model context window; denominator for the status-line `ctx` fill gauge and the basis for compaction and the payload cap.                                                                                                     |
| `REIKA_MIN_GEN_TOKENS`   | _learned_ (from `2048`) | Generation room reserved from the window.                                                                                                                                                                                    |
| `REIKA_MAX_TOKENS`       | _unset_                 | Cap response tokens per call (cloud cost/latency control).                                                                                                                                                                   |
| `REIKA_REASONING_ROUNDS` | `2`                     | Recent tool-call rounds that keep their reasoning in context (rest pruned). 1 = leanest; higher avoids re-derivation on thinking models, at a token cost                                                                     |
| `REIKA_REPO_MAP_BUDGET`  | scales with the window  | Chars allotted to repo map in system prompt. Unset, 5% of the context window, between 3200 and 12000 (3200 when no window is known); set, it pins the value                                                                  |
| `REIKA_MAX_TURNS`        | `200`                   | Tool-call iterations per user turn. A termination backstop for loops the detectors miss, not a cost cap — sized so a healthy complex turn never hits it; in the TUI ctrl-c is the real cap, in headless this is the only one |

- **`REIKA_CONTEXT_WINDOW`** — Per-profile override available. Unset asks the endpoint
  (`/v1/models`: llama.cpp's `n_ctx`, vLLM's `max_model_len`, floored to the thousand), then the
  models.dev catalog for hosted endpoints; when neither has one, a startup warning says so and the
  gauge shows absolute tokens, no %
- **`REIKA_MIN_GEN_TOKENS`** — Drives the per-turn `max_tokens` backstop, the payload cap reserve,
  and the compaction trigger. Unset, it starts at 2048 and rises to cover the rounds the model
  actually generates (p90 of the last 16 finished rounds, +25%, capped at a quarter of the window),
  so a thinking model grows its own think-room. Setting it pins that value — 6144 gives a 16k
  thinking model the room from round 0. Per-profile override. Needs a known context window
- **`REIKA_MAX_TOKENS`** — Per-profile override available

## Approvals, sandbox and command bounds

| Key                        | Default                 | What                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_AUTO_APPROVE`       | `safe`                  | Approval mode. `safe` (the default; also `true`/`1`) auto-approves edit/write/bash but still prompts for dangerous commands and for any write that lands outside the project directory; `bypass` (or `yolo`) skips all prompts, and refuses out-of-project writes outright since there is no prompt to fall back on; `off` (or `false`/`0`, and what any unrecognized value resolves to) confirms everything. |
| `REIKA_UNATTENDED`         | unset                   | `1` for a TUI session nobody is watching (a long turn left to grind while you're away, or overnight): anything the approval mode would prompt for is declined instead of opening a dialog, and `ask_user` is not offered — headless's rule.                                                                                                                                                                   |
| `REIKA_SANDBOX`            | `1` on macOS            | Run model-chosen shell commands under a kernel-enforced local sandbox (Seatbelt, via the system `sandbox-exec` — no bundled dependency).                                                                                                                                                                                                                                                                      |
| `REIKA_BASH_TIMEOUT_MS`    | `1800000`               | Wall-clock ceiling on a single bash command, ms (30 min — a slow build or a full test suite).                                                                                                                                                                                                                                                                                                                 |
| `REIKA_BASH_IDLE_MS`       | `300000`                | Kill a bash command that has written nothing for this long, ms (5 min).                                                                                                                                                                                                                                                                                                                                       |
| `REIKA_REQUEST_TIMEOUT_MS` | `0` (wait indefinitely) | How long the model server may send **nothing at all** before the request is aborted, ms.                                                                                                                                                                                                                                                                                                                      |

- **`REIKA_AUTO_APPROVE`** — Leave it unset to keep `/approvals off` available as a session toggle
  — an explicit `safe`/`bypass` shadows it
- **`REIKA_UNATTENDED`** — The model is told nobody was there to approve, so it continues without
  the step or leaves it for you; each turn ends with a `Declined while unattended` notice listing
  what was left, and the prompt's ask rule becomes "pick the most reasonable reading and name each
  such choice in your final reply". Combines with `REIKA_AUTO_APPROVE` (`off` + unattended declines
  every edit and command); does nothing under `bypass`, where nothing prompts. Sets the starting
  state; `/unattended on\|off` switches it mid-session (whether `ask_user` is offered stays as
  launched). The status bar shows an `unattended` chip
- **`REIKA_SANDBOX`** — Writes are confined to the working directory, temp and cache dirs; network
  is denied except loopback and unflagged `git`/`gh` reads (`gh pr view`, `git fetch`), so a local
  model server, a test suite's own listener and the shipped `/issue`/`/review` skills all work. A
  command the danger scan flags prompts a human first and, once cleared, runs unsandboxed — which is
  what lets `npm install`/`git push` work without a proxy. Under `bypass` every command is
  sandboxed, because there is no prompt to fall back on. Reads stay open (a blocklist of secret
  paths is incomplete by construction). macOS only — on Linux it reports unavailable and behaves as
  before, since bubblewrap's `--unshare-net` gives the child its own loopback and would block the
  host's model server. `0` disables
- **`REIKA_BASH_TIMEOUT_MS`** — `0` disables
- **`REIKA_BASH_IDLE_MS`** — A hang — a server, a watcher, a prompt waiting on input — goes
  silent, so this is the bound that catches it without shortening the ceiling for real work. `0`
  disables
- **`REIKA_REQUEST_TIMEOUT_MS`** — Unset, reika waits as long as it takes — llama.cpp emits no
  bytes while it prefills, and a model streamed off SSD can be silent for a very long time and still
  be working (Node's own default would kill the turn at 300s). Esc cancels a server that really is
  hung. Set a positive value to cap the wait

## Subagents

| Key                        | Default              | What                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SUBAGENT_MODEL`     | _falls back to main_ | Override model for subagents                                                                                                                                                                                                                                                |
| `REIKA_SUBAGENT_BASE_URL`  | _falls back_         | Override server for subagents                                                                                                                                                                                                                                               |
| `REIKA_SUBAGENT_API_KEY`   | _falls back_         | Override key for subagents                                                                                                                                                                                                                                                  |
| `REIKA_SUBAGENT_MAX_TURNS` | `8`                  | Subagent round budget. The last round is the report round: every tool is withdrawn and the subagent is told to write up what it has, with a "Not covered" list, so the parent always gets a report and never `(reached max turns…)`.                                        |
| `REIKA_SUBAGENT_PRESSURE`  | `1`                  | The mid-session subagent trigger: when a `grep`/`glob` result spans 4+ files and reading them would push the request over the compaction threshold, the result gets a one-line footer pointing at `subagent` — an observation at the moment of decision, not a prompt rule. |

- **`REIKA_SUBAGENT_MAX_TURNS`** — Keep it tighter than `REIKA_MAX_TURNS`
- **`REIKA_SUBAGENT_PRESSURE`** — Once per turn; never inside a subagent. Preferred over
  `REIKA_SUBAGENT_NUDGE`, whose round-0 routing pays a subagent run whether or not the parent had
  room. Needs a known context window (there is no threshold to measure against without one), so on a
  windowless session it never fires. `0` is the baseline arm

## Images

| Key                     | Default      | What                                                                                                                                                                                              |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_VISION`          | describe     | Pasted images: describe (default) reads the image into text first — vision model or system OCR; native sends the bytes to the model as a multimodal image part, for a model that can already see. |
| `REIKA_VISION_MODEL`    | _unset_      | Vision model for pasted/dragged-in images.                                                                                                                                                        |
| `REIKA_VISION_BASE_URL` | _falls back_ | Override server for the vision model                                                                                                                                                              |
| `REIKA_VISION_API_KEY`  | _falls back_ | Override key for the vision model                                                                                                                                                                 |
| `REIKA_OCR_LANGS`       | _unset_      | Preferred languages (BCP-47, comma-separated) for OCR of pasted images, e.g. `en-US,ja-JP`.                                                                                                       |

- **`REIKA_VISION`** — Per-profile as `REIKA_<NAME>_VISION`, since it is a property of the model,
  not the machine. Native sends the image once, for the turn it was pasted in, and history keeps a
  short not-transcribed note in its place.
- **`REIKA_VISION_MODEL`** — When set, images are described by this model instead of going through
  system OCR — the description reaches the main model as text, so the main model can stay text-only.
  Used for nothing else
- **`REIKA_OCR_LANGS`** — Unset uses the platform recognizer's default. Windows uses only the
  first entry

## Web tools

| Key                           | Default | What                                                                                                      |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `REIKA_SEARXNG_URL`           | _unset_ | SearXNG instance URL (self-hosted, local-first); enables the `search` tool when CDP search is not in use. |
| `REIKA_CDP_SEARCH`            | _auto_  | Drive a real Chrome over CDP for `search`.                                                                |
| `REIKA_CDP_PORT`              | `9222`  | Chrome remote-debugging port for the above.                                                               |
| `REIKA_CHROME_PATH`           | _unset_ | Override Chrome/Chromium binary discovery for CDP search                                                  |
| `REIKA_PASTE_FETCH`           | `1`     | Fetch `http(s)` URLs pasted into a prompt before the turn runs (up to 2, 8k chars each).                  |
| `REIKA_MAX_SEARCHES_PER_TURN` | `3`     | Cap `search` calls per user turn (prevents runaway / quota burn)                                          |
| `REIKA_MAX_FETCHES_PER_TURN`  | `5`     | Cap `fetch_url` calls per user turn                                                                       |

- **`REIKA_SEARXNG_URL`** — `fetch_url` registers regardless
- **`REIKA_CDP_SEARCH`** — drives a real Chrome over CDP for `search`; unset is **auto**. Three
  things to know:
  - **When it is on** — on macOS it is used whenever Chrome or Chromium is installed; elsewhere off,
    because the launch opens a visible window that takes focus. `1` opts in on any platform (and
    fails loudly without a browser), `0` turns it off.
  - **Which provider wins** — this **takes priority over `REIKA_SEARXNG_URL` whenever it is in use**,
    and a startup line names the winner when both are configured: SearXNG reaches engines as a bare
    HTTP client, which is the shape they CAPTCHA, where a browser on a persistent profile keeps
    being served.
  - **What it launches** — nothing until the first search, since detection only checks for the
    binary. Then a separate backgrounded instance on its own profile at `~/.config/reika/chrome`,
    never focused on macOS and never headless (a fresh headless profile is what gets challenged); it
    reattaches across searches and shuts down after 10 idle minutes
- **`REIKA_CDP_PORT`** — An instance already listening here is reused rather than relaunched
- **`REIKA_PASTE_FETCH`** — `0` disables — an outbound request per pasted link

## Skills and prompts

| Key                | Default                  | What                                                                                                                                                      |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SKILLS_DIR` | `~/.config/reika/skills` | Directory of `*.md` skill files, each of which becomes a slash command.                                                                                   |
| `REIKA_SKILL_AUTO` | `ask`                    | What a command-shaped skill match may do to your prompt.                                                                                                  |
| `REIKA_ASK`        | `1`                      | The `ask_user` tool: the model can put one multiple-choice question to you mid-turn instead of guessing when what it read contradicts what you asked for. |

- **`REIKA_SKILLS_DIR`** — `<cwd>/.reika/skills/` shadows it on name collision — see
  [Skills](skills.md#skills-reusable-prompt-templates)
- **`REIKA_SKILL_AUTO`** — `ask`: the TUI opens a two-row confirm before submit (`Send as typed`
  selected / `Apply /review`); headless (`-p`) sends the prompt as typed. `apply` (also `1`): the
  TUI still asks; headless applies a strong match without asking, on prompts of 12 words or fewer.
  `off`: the one-line hint only. See [Skills](skills.md#skills-reusable-prompt-templates)
- **`REIKA_ASK`** — `0` removes the tool, and with it the agent and plan prompts' lines about
  asking

## MCP servers

| Key                 | Default | What                                                                                                              |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `REIKA_MCP_SERVERS` | _unset_ | MCP servers to run alongside the session, as JSON or as the path of a JSON file.                                  |
| `REIKA_MCP`         | `1`     | `0` turns configured MCP servers off for the session — the baseline arm for a run measuring behavior without them |

- **`REIKA_MCP_SERVERS`** — Three document shapes are accepted: the standard `{"mcpServers":
{"name": {"command": …}}}`, that map without the wrapper, and a list of `{"name": …,
"command": …}`. Each entry is `command` plus optional `args`, `env`, `cwd`, `timeoutMs` (per
  call, default `60000`) and `connectTimeoutMs`
- **Handshake timeout** — `connectTimeoutMs` bounds the handshake — `server/discover` or
  `initialize`, and `tools/list` — and defaults to 15000, because it is paid before the first
  frame: a server that hangs at startup must not hold the session, and one behind a cold `npx`
  install can need longer than the default to say hello
- **Transport** — Reika speaks MCP's **stdio** transport (JSON-RPC 2.0, newline-framed) in both
  protocol eras: `2026-07-28` to a server that answers `server/discover`, the `initialize`
  handshake (`2025-11-25` back to `2024-11-05`) otherwise; then `tools/list` (paginated) and
  `tools/call`
- **Environment** — A server inherits only `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`,
  `TMPDIR` and the locale from reika's environment — not its API keys — so give it anything else
  through `env`
- **Tools** — Every tool it finds joins the **agent** tool list as `mcp__<server>__<tool>`, and
  becomes a `/<server>:<tool>` slash command; `/mcp` lists them. Agent mode only — an MCP tool is
  opaque to the harness, so plan/chat/minimal/grind (whose guarantees are structural) never get
  one
- **Approval** — A tool call goes through the approval gate with no danger warnings: under `safe`
  it runs, under `off` it prompts, under `bypass` it runs unprompted. Set `"approve": "always"` on
  a server whose tools send data somewhere, and every call from it prompts even under `safe` (and
  is refused under `bypass`, declined when unattended). Leaving `approve` out — or spelling the
  ordinary gate as `"auto"` — is what it does otherwise; any other value, a typo like `"alway"`, is
  reported as a config error
- **Failure** — A server that fails to start is reported at startup and skipped — the session
  opens anyway. Stdio only; remote HTTP/SSE servers are not supported

## Diagnostics

| Key                      | Default                             | What                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_DEBUG`            | _unset_                             | Any non-empty value writes diagnostics (session-start bundle size, loop/spiral detectors, grounding, prefix-cache classification with the prefill cost it implies, per-round entropy/KL drift, etc.) to a log file. |
| `REIKA_DEBUG_FILE`       | `~/reika-debug.log`                 | Path for the `REIKA_DEBUG` log. The default log is reset at the start of each session; an explicit `REIKA_DEBUG_FILE` is always appended to, so use it when an experiment should accumulate across runs             |
| `REIKA_ENTROPY`          | _unset_                             | `1` asks the server for per-token logprobs, so the `REIKA_DEBUG` drift lines report the model's real predictive entropy (and how surprised it was by its own output) instead of the entropy of the text alone.      |
| `REIKA_TSCONFIG`         | _unset_                             | Override the tsconfig the post-edit typecheck gate uses (relative to cwd or absolute).                                                                                                                              |
| `REIKA_SPILL_STATS`      | _unset_                             | `1` appends one JSON line per over-cap tool result — and per call that opens a saved artifact — to a stats file.                                                                                                    |
| `REIKA_SPILL_STATS_FILE` | `~/.config/reika/spill-stats.jsonl` | Path for the `REIKA_SPILL_STATS` file. Always appended to — unlike the debug log, it is meant to accumulate across sessions                                                                                         |

- **`REIKA_DEBUG`** — Goes to a **file**, never stderr — stderr would corrupt the Ink TUI frame
- **`REIKA_ENTROPY`** — Needs `REIKA_DEBUG` — the log is the only consumer — and costs a much
  larger streamed response (top-5 candidates per token). The per-round entropy/KL lines are written
  either way; this only sharpens the entropy half. A server that rejects the fields is retried once
  without them, so it can't cost a turn
- **`REIKA_TSCONFIG`** — For layouts auto-detection can't reason about — references-only roots, or
  named-variant-only projects (`tsconfig.web.json`, …) with no plain `tsconfig.json`. Normally
  auto-detected: walks up from the edited file to the nearest `tsconfig.json`
- **`REIKA_SPILL_STATS`** — Sizes and tool names only, never output. Measurement, not a feature:
  an eval can show the model follows a locator, but only real use answers what share of your `bash`
  calls exceed the 64KB cap at all, which is what decides whether the retained window is sized
  right. Off by default; no behavior change while it runs

## Loop breaking and context management

| Key                         | Default           | What                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_COMPACTION_REPORT`   | `1`               | A report round before each compaction fold: one extra model call with tools withdrawn asks for a short _compaction note_ — what it has established (file paths, function names, quoted strings) and what is still open — and the fold carries that note as the recap's body instead of the read ledger.                                                                                            |
| `REIKA_CONTINUE`            | `1`               | Carries a reasoning block cut off mid-thought forward instead of discarding it and asking the model to start over.                                                                                                                                                                                                                                                                                 |
| `REIKA_CONTINUE_TAIL_CHARS` | `6000`            | How much of the cut-off block comes back (default `6000` ≈ 1500 tokens).                                                                                                                                                                                                                                                                                                                           |
| `REIKA_CONTINUE_MAX`        | `3`               | Consecutive continuations allowed without progress, where progress is a tool call or a committed answer (default `3`).                                                                                                                                                                                                                                                                             |
| `REIKA_DROPPED_LEDGER`      | `1`               | Tells the model, once per request, that some tool results above show only a summary line because their output was dropped to make room — a context limit, not a command that failed, and not a result it already handled.                                                                                                                                                                          |
| `REIKA_DEDUP_PAYLOADS`      | `1`               | Replaces a tool result whose serialized bytes repeat an earlier one — an aged summary trail like `Read A / Read A / Read A`, or two identical reads in one round — with a short stub pointing back at the first copy.                                                                                                                                                                              |
| `REIKA_PREFIX_STABLE`       | `1` with a window | Keeps requests append-only between context-shrink events so the inference engine's prompt-prefix cache stays valid: tool payloads stay live and age in one batch at the compaction threshold instead of every round, and loop/plan nudges ride a trailing note instead of the system prompt.                                                                                                       |
| `REIKA_AGE_LOW_FRACTION`    | `0.7`             | How far below the compaction threshold each prefix-stable shrink event sheds, as a fraction (clamped to 0.3–0.95, ignored when `REIKA_PREFIX_STABLE` is off).                                                                                                                                                                                                                                      |
| `REIKA_PLAN_HANDOFF`        | `1`               | Folds the plan-mode exploration transcript into a single digest at the plan→agent boundary, keeping the original request and the written plan verbatim — so on a small window the raw read payloads and reasoning from planning don't crowd out the agent's own loop and let the plan decay.                                                                                                       |
| `REIKA_PLAN_BASH`           | `1`               | Registers a **read-only** `bash` in plan (and vibe) mode: commands a strict allowlist classifier can prove read-only (`grep`/`cat`/`head`/`find`/`wc`/… and pipelines of them) run; anything that could write or run something else — redirection, command substitution, `sed`/`awk`, any unlisted command — is refused with the rule stated.                                                      |
| `REIKA_REASONING_LOOP`      | `1`               | Acts on detected reasoning rumination (the model re-deriving the same analysis across rounds while tool results look new; measured over 8-gram self-repeat + cross-round similarity): plan mode gains a force-write trigger, agent mode drives the ledger→withdrawal ladder and, past it, an honest terminal stop.                                                                                 |
| `REIKA_READ_FIRST`          | `1`               | Read-first edit gate: the first `edit` to a file whose contents are no longer in the model's context (never read, or the read has since aged out) is held back once with a directive to read it, so a blind `old_string` never gets the chance to fail and spiral.                                                                                                                                 |
| `REIKA_PLAN_VERIFY`         | `1`               | Grounds a finalized plan against the codebase: paths and backticked identifiers it names are checked (paths by `stat`, symbols by a bounded tree walk) and any not found are appended as a "may be new" advisory the agent turn inherits — heading off the agent hunting on 0-match greps or edits whose `old_string` is in no file.                                                               |
| `REIKA_PLAN_ALIGN`          | `1`               | Plan-alignment pressure on top of the (always-on) step checklist: the checklist is pinned into the system prompt each round during implementation, and a turn that stops with observable steps unchecked is bounced back once (leftovers are then waived, not re-asked).                                                                                                                           |
| `REIKA_LOGIT_RECOVERY`      | `1`               | Spends one last-resort biased round before the terminal reasoning-loop stop: a mild one-shot `logit_bias` (−4, capped, tool-name tokens exempt) down-weighting the loop's own recurring tokens. llama.cpp-only (needs the native `/tokenize` endpoint) and inactive under `REIKA_REASONING_LOOP=0`; degrades to the honest stop if it doesn't help.                                                |
| `REIKA_CONVERGE_RETRY`      | `1`               | Inserts one steered retry before the honest give-up stop (plan and agent): a strong, failure-naming directive ("you looped and kept re-questioning yourself; commit to one analysis and do it") instead of a cold stop.                                                                                                                                                                            |
| `REIKA_VERBATIM_ABORT`      | `1`               | Cuts a single runaway reasoning block mid-stream — on a length-aware self-repeat ratio, or an absolute length ceiling for low-repetition semantic spirals — instead of letting it run to the `max_tokens` wall; a length cut whose repetition ratio is low is carried forward like a token-wall cut (`REIKA_CONTINUE`), and a degenerate one recovers by mode (plan → force-write, agent → nudge). |
| `REIKA_SELF_AWARE`          | `1`               | One line in the agent and plan prompts saying the model runs inside reika, with the path to the shipped `docs/`, the skills directories and the saved sessions — scoped to questions about reika itself, so it doesn't pull the model into those paths otherwise.                                                                                                                                  |
| `REIKA_CALLER_CHECK`        | `1`               | One agent-prompt rule: after changing what a function accepts, returns or throws, find and read every caller and fix any the change breaks.                                                                                                                                                                                                                                                        |
| `REIKA_SPILL`               | `1`               | Saves an over-cap `grep`/`glob`/`bash` result to a session-scoped temp file and appends the path to the inline page, so the bytes the cap drops stay reachable — the model pages the file with `read`/`grep` instead of re-running the search or the command.                                                                                                                                      |

- **`REIKA_COMPACTION_REPORT`** — Numbered per session; each note supersedes the last; one retry
  if the reply carried no note. `0` restores the ledger-only recap. Measured: a model that had every
  file by round 6 folded five times and re-read them after each fold without it; with it, 11 rounds
  / 1 fold / a correct answer on the same prompt
- **`REIKA_CONTINUE`** — The trimmed **tail** is promoted into the `content` channel (a chat
  template renders prior-turn `reasoning_content` as nothing — which is why the old retry lost work
  that was sitting in history) and followed by a resume nudge. Gated on the self-repeat **ratio**,
  not on which cut fired: the `max_tokens` wall and `REASONING_HARD_CEIL` landed 5.4% apart on a
  measured run, so both route through the same gate and a genuinely degenerate block is still
  discarded. Agent mode and plan exploration; never the plan force-write round, whose tighter
  ceilings catch a spiraling transform. `0` is the baseline arm for a run measuring
  context/eviction, since a carried tail changes what a request holds
- **`REIKA_CONTINUE_TAIL_CHARS`** — A truncated block's conclusion sits at its **end**, so a tail
  keeps the payoff and drops the earlier circling by ordering alone. Value falls off with size while
  cost is linear — the tail sits in the next round's prompt and eats the generation room the
  continuation needs — so on a small window more is not better
- **`REIKA_CONTINUE_MAX`** — Resets on progress, so there is no ceiling on how many times a
  session may continue — only on continuing without producing anything. A novelty check stops a
  continuation that merely restates the previous one
- **`REIKA_DROPPED_LEDGER`** — Without it an aged result reads like success: on a `/review` run
  the model reconstructed a diff from memory and only afterwards doubted itself, where the same
  situation with the notice produced "the output got dropped, let me re-run it". Stated as
  one ledger line rather than per message — per-message measured ~19% of a long turn's request — and
  only when something really was dropped, so it can never claim a loss that didn't happen. Rides the
  system suffix, or the trailing note under `REIKA_PREFIX_STABLE`. `0` is the baseline arm
- **`REIKA_DEDUP_PAYLOADS`** — Deterministic and keep-first; a stubbed copy's budget goes to the
  survivors. Bypassed whenever `REIKA_PREFIX_STABLE` is active (a stub flipping on a later duplicate
  would rewrite mid-history bytes and invalidate the prefix cache), so with a context window set it
  changes nothing — it reaches sessions with no `REIKA_CONTEXT_WINDOW` or with
  `REIKA_PREFIX_STABLE=0`, where every older payload is already a summary and per-round aging
  rewrites mid-history anyway. `0` is the baseline arm
- **`REIKA_PREFIX_STABLE`** — Cuts per-round prompt re-processing on llama.cpp (SWA/hybrid-memory
  models especially, which re-process the whole prompt on any prefix change), at the cost of a
  fuller context between events. One mid-context edit re-prefilled 8453 tokens, 7.9 min at 22.9
  tok/s, against 25 tokens for an append. Inactive without `REIKA_CONTEXT_WINDOW` (or a window the
  endpoint reports). Takes precedence over `REIKA_DEDUP_PAYLOADS`. `0` is the per-round baseline
- **`REIKA_AGE_LOW_FRACTION`** — A shrink event re-processes most of the prompt, so a lower value
  means fewer of them per run — three events were ~24 min of a 2h15m run — at the cost of a
  smaller live working set between events. A tuning knob for measuring that trade
  (`evals/prefixcost-report.ts`), not a setting with a known better value
- **`REIKA_PLAN_HANDOFF`** — `0` is the baseline arm
- **`REIKA_PLAN_BASH`** — Plan mode still cannot mutate the repo; the guarantee lives in the
  classifier rather than the tool's absence. `0` removes the tool and reverts the plan prompt
- **`REIKA_REASONING_LOOP`** — Detection always runs and feeds the debug line; `0` turns off only
  the action
- **`REIKA_READ_FIRST`** — Fail-open — re-issuing the edit applies it as-is — and at most one
  extra round per file per turn. Under `REIKA_DEBUG` each bounce logs `would-land=yes\|no`: whether
  the withheld edit would have applied, i.e. how often the gate cost a round versus caught a blind
  edit. `0` turns it off
- **`REIKA_PLAN_VERIFY`** — Advisory only, one-directional (under-flags rather than over-flags).
  `0` turns it off
- **`REIKA_PLAN_ALIGN`** — `0` turns it off (the checklist itself stays)
- **`REIKA_LOGIT_RECOVERY`** — `0` turns it off
- **`REIKA_CONVERGE_RETRY`** — Capped at one; worst case is unchanged — the same stop fires once
  the budget is spent. `0` turns it off
- **`REIKA_VERBATIM_ABORT`** — The only pre-cap backstop for a never-ending single block. `0`
  turns it off
- **`REIKA_SELF_AWARE`** — Never names the `.env` (API keys) or the binary. `0` removes the line
- **`REIKA_CALLER_CHECK`** — Grind mode's step 6 on its own: on the chunk fixtures
  deepseek-v4.1-flash went from 4/10 to 10/10 with it, a local 27B started searching for callers
  (0/3 → 2/3 runs), and it added no calls on fixtures without callers. Agent mode only. `0` is
  the baseline arm
- **`REIKA_SPILL`** — Adds no tool and no schema; the locator points at tools the model already
  has. Fail-open (a spill that can't be written leaves the ordinary capped result) and a strict
  no-op when off. `bash` is the case where the _end_ is what matters — it stopped draining at the
  cap, so a long build or test run lost the failure at the end of it; the payload keeps the head and
  a bounded 4MB window keeps the tail. `fetch_url` saves every page over 2KB, not just over-cap
  ones, and puts the locator in the summary too: the cut that hits a fetched page is usually the
  context window, not the tool cap, and the marker at that cut says to read a narrower range —
  advice only followable once the page is a local file. A URL fetched again in the same session is
  served from that file with no request and no budget use, and the compaction recap lists saved
  pages by locator, so a page the session already read stays reachable through every fold.
  Benched on a 2300-file monorepo, where `**/*.ts` matched 560 files whose 200-path page covered 3
  of 5 packages — the concentration a small repo never reveals, since a cap it cannot reach behaves
  identically to the flag being off. `0` disables — which is also how the A/B baseline is spelled

## Terminal

| Key                  | Default | What                                                                                                                                                                             |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SYNC_OUTPUT`  | `1`     | Wraps every Ink frame in one synchronized write (DEC mode 2026) so the terminal paints it atomically.                                                                            |
| `REIKA_BASIC_GLYPHS` | auto    | Draws the UI with glyphs a basic console font carries (`●`, `└`, `│`, square borders, an ASCII spinner) in place of the ones it lacks (`⏺`, `↳`, `▎`, rounded borders, braille). |

- **`REIKA_SYNC_OUTPUT`** — Ink paints a frame as erase-then-redraw, three separate writes when a
  message commits to scrollback, and a process swapped out under memory pressure (a large local
  model on a small machine) leaves the terminal showing the erased state between them as flicker.
  iTerm2, kitty, WezTerm, Ghostty, Alacritty, foot, Windows Terminal, VS Code and tmux ≥
  3.3 honor the mode; others ignore it harmlessly. `0` restores plain writes
- **`REIKA_BASIC_GLYPHS`** — Auto turns it on for `TERM=linux` (the Linux console) and `vt*`; `1`
  forces it for a terminal auto misses, such as an old Windows console font; `0` keeps the full set.
  Colors step down on their own: a 16-color terminal gets a named-color palette instead of the
  pastels, and `FORCE_COLOR=1` forces that palette where color detection guesses too high (an ssh
  session that inherited `COLORTERM`)

## Experimental flags

Feature-flagged subsystems, all **off by default** in code (set to `1` to enable), being trialled
before becoming default. [`.env.example`](../.env.example) turns on every flag in the table below
except `REIKA_ANON` and `REIKA_SUBAGENT_NUDGE` (superseded by the pressure trigger above): for now
they are worth enabling for a better experience, and they become default once further tested — as
`REIKA_SPILL`, `REIKA_PLAN_HANDOFF`, `REIKA_SUBAGENT_PRESSURE`, `REIKA_PLAN_VERIFY`,
`REIKA_PLAN_ALIGN`, `REIKA_LOGIT_RECOVERY`, `REIKA_CONVERGE_RETRY` and `REIKA_VERBATIM_ABORT`
already have, which is why they sit in the table above rather than here. See the "Loop breaking &
spiral handling" / "Modes" / "Context management" sections of [`AGENTS.md`](../AGENTS.md) for the
full rationale. They mostly matter for small/quantized local models; on a strong cloud model they're
low-value (and a couple cost a little).

| Key                    | What `1` does                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SUBAGENT_NUDGE` | Adds one routing rule to the agent prompt (rule 3, next to the grep rule): a request to trace/explain/summarize how something works across several files goes to `subagent` as the FIRST call, with the paths and symbols the model already knows, so those reads land in the main context as one digest instead of N payloads. |
| `REIKA_URL_GROUNDING`  | Fetches http(s) URLs a write/edit (or a finalized plan) introduces, on the model's behalf, and appends a ✓/✗ receipt — catching a plausible-but-wrong link that would otherwise fail silently at runtime.                                                                                                                       |
| `REIKA_WARM`           | Speculative KV-cache warming: the first keystroke of a prompt fires a throwaway 1-token request carrying the exact prefix the submit will send (system + history), so a llama.cpp-style server prefills its cache in the typing gap and the real request re-processes only the user message.                                    |
| `REIKA_ANON`           | Replaces your own git author name/email and your GitHub/GitLab/HuggingFace account slug with `<user>`/`<email>` in the scrollback and in saved transcripts, for screenshots and shared logs.                                                                                                                                    |

- **`REIKA_SUBAGENT_NUDGE`** — One-or-two-file questions are read directly. Exploration only; the
  tool and its own trigger text are unchanged. Off, the prompt is byte-identical, so it A/Bs cleanly
- **`REIKA_URL_GROUNDING`** — Mirrors the dep grounder: capped (2/call), per-turn deduped,
  offline-safe (a no-response URL is called dead only when another URL in the batch proved
  connectivity). Only a 404/410 or an unresolvable name counts as a dead link; a refusal
  (401/403/429), a server error, and a 404 from a code host (a private repo) or an API path are
  reported as unverified instead. Never fetches a URL carrying a secret (userinfo, a token/key/signature query
  parameter, a webhook), an internal or reserved name, or a host that resolves to a private address,
  and leaves the last two fetch slots of each turn to the model
- **`REIKA_WARM`** — Fail-open; skipped when the next turn would compact. Best on slow-prefill
  local setups; a needless (tiny) cost on paid APIs
- **`REIKA_ANON`** — Identity is looked up once at startup (git config, remotes, and the author
  lines in recent commits) and substituted as literals — third-party owners like `anthropics/` or
  `Qwen/` are untouched, because a pattern sweep over `owner/repo` cannot tell yours from theirs.
  Display only: the model still receives everything verbatim

## Multiple models

There are two ways to expose more than one model, and they compose.

**Same base URL (e.g. a model router).** Just list the models in `REIKA_MODEL`, comma-separated.
They all share `REIKA_BASE_URL`/`REIKA_API_KEY`; the first is the default, and the rest are
switchable with `/model <name>` — no extra env vars to add or remove as your router's catalogue
changes:

```ini
REIKA_BASE_URL=http://localhost:8080/v1
REIKA_MODEL=qwen3-coder,kimi-k2,glm-4.6   # /model kimi-k2 to switch
```

**Different endpoints/keys — named profiles.** When a model lives behind a different base URL or API
key, define a full profile and switch between them at runtime with `/model <name>`:

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

Per-profile `_MAX_TOKENS`, `_CONTEXT_WINDOW`, and `_MIN_GEN_TOKENS` fall back to the corresponding
global defaults if unset. When a context window is known, `max_tokens` is computed per turn as the
room actually left (`window − prompt − margin`), capped by `REIKA_MAX_TOKENS` if you set one — so
you usually don't need to set `_MAX_TOKENS` at all; size `_MIN_GEN_TOKENS` instead to reserve
think-room. If you _do_ pin `_MAX_TOKENS`, **set it generously** — a value low enough to truncate
mid-JSON breaks tool calls silently, and reasoning models (DeepSeek-R1, Kimi K2) need extra headroom
since the thinking phase counts toward the cap.

Then in-session:

- `/model` — show the current selection and list available models (default base URL) and named profiles
- `/model kimi-k2` — switch to a model on the default base URL (model name only swaps)
- `/model kimi` — switch to a named profile (model + endpoint + key swap as a unit)
- `/model some-new-model` — a name that isn't in your config still switches: it rides the current base URL/key, so you can test a model without touching `.env`. The switch message and picker flag it as `(not in config)`
- `/new` — resets to default

Conversation history persists across switches; if styles clash, run `/new` first. Token counter
accumulates across models/profiles for a single session bill.

The selection persists: the next session opens on the profile you last switched to (see [Last
session state](#last-session-state)).

### Per-mode models

`REIKA_MODE_MODELS` binds a model to a mode, so the switch happens with the mode instead of with a
`/model` at every change — a big model to plan, a careful one to grind, a cheap one for chat:

```ini
REIKA_MODEL=qwen3.5-9b                    # the session's own model
REIKA_PROFILES=kimi
REIKA_KIMI_MODEL=kimi-k2.6
REIKA_KIMI_BASE_URL=https://api.moonshot.ai/v1
REIKA_KIMI_API_KEY=sk-...
REIKA_MODE_MODELS=plan=kimi,chat=qwen3.5-9b
```

Each value is what `/model <name>` accepts — a named profile, or one of `REIKA_MODEL`'s models
(which lands on the profile that serves it). The modes are `agent`, `plan`, `vibe`, `minimal`,
`grind` and `chat`; `shell` runs no model, so it takes no entry.

What it does, in order:

1. **At startup** the start mode's model wins over the profile the last session saved. A launch
   `REIKA_MODEL=x reika` still wins over both — it names the model for _this_ session, and redefines
   the default profile. `REIKA_DEFAULT_MODE=plan reika` picks the mode, not the model, so plan's own
   model is what it runs.
2. **On a mode switch** the new mode's model applies. A mode with no entry of its own returns to the
   session's own model — the profile it opened on — so `plan → agent` is a round trip rather than a
   one-way switch onto the plan model.
3. **A `/model` you pick by hand outranks the map for the rest of the session**: from then on, mode
   switches leave the model where you put it. `/new` starts a new session and the map applies again.
4. Headless (`-p --mode=plan`) honors it too, since there is no `/model` there: the config decides.

## Last session state

Reika remembers the mode and profile you last used in `~/.config/reika/state.json` and opens the
next session on them — a `/model kimi` or `/plan` carries over without touching `.env`. When it
does, the scrollback says so (`Resumed plan mode and profile 'kimi' (kimi-k2) from the last
session.`). The precedence is:

1. **Given at launch** — `REIKA_MODEL=x reika`, or an `export` in your shell rc. A model the shell
   hands Reika is what _this_ session should be, and beats everything below. `REIKA_DEFAULT_MODE=plan
reika` names the mode instead: it picks the mode, and that mode's own model from the next line comes
   with it.
2. **The start mode's model** — `REIKA_MODE_MODELS` (see [Per-mode models](#per-mode-models)), when
   the mode has one. It is what that mode _is_, so the saved profile below is only where the last
   session happened to be.
3. **The last session** — `state.json`.
4. **`.env` files** — `REIKA_DEFAULT_MODE` / `REIKA_MODEL` there are the defaults the saved state overrides.

Only the launchable modes are remembered (agent, plan, minimal, grind, vibe); ending in chat or
shell leaves the last work mode on record. A mode's own model is never saved as a profile — it is
re-derived from `REIKA_MODE_MODELS` on every launch, so removing an entry puts the session back on
its own model rather than stranding it on that mode's. A saved profile the config no longer has — a
removed `REIKA_PROFILES` entry, or an ad-hoc `/model some-new-model` that was never in `.env` —
falls back to `default` rather than being recreated. `/new` resets to agent and `default`, and that
is remembered too. Headless runs (`-p`) neither read nor write it: a script's behavior should
follow from its env, not from the last interactive session. Delete the file to forget.
