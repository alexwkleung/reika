# Configuration

[← README](../README.md)

Config sources, in precedence order (higher wins):

1. **Shell env vars** (e.g. `export REIKA_MODEL=qwen3.5-9b` in `~/.zshrc`).
2. **Project `.env`** (cwd where you run `reika`) — per-project overrides.
3. **Global `~/.config/reika/.env`** — defaults for a global install.

The project `.env` belongs to whatever repo you open, so it is read narrowly: only `REIKA_*` keys,
and never the ones that change the sandbox, approvals, endpoints, keys or MCP servers
(`REIKA_SANDBOX`, `REIKA_AUTO_APPROVE`, `REIKA_MCP`, `REIKA_MCP_SERVERS`, `REIKA_PASTE_FETCH`,
`REIKA_SKILL_AUTO`, `REIKA_URL_GROUNDING`, `REIKA_CDP_SEARCH`, `REIKA_CDP_PORT`,
`REIKA_DEBUG_FILE`, and every key ending in `_URL` or `_API_KEY`). Set those in your shell or the
global file; Reika prints a warning naming any it ignored.

The keys are grouped by area below. In each table, the **Default** column is what Reika uses when
the key is unset. [`.env.example`](../.env.example) is a tuned starting point rather than a copy of
those defaults: a few of its values are deliberately larger, sized for a local reasoning model with
room to work rather than for the smallest safe fallback. Trim them for a tiny model or a tight
window.

## Endpoint, models and profiles

| Key                  | Default                    | What                                                                                                                                                                            |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_BASE_URL`     | `http://localhost:9931/v1` | OpenAI-compatible endpoint                                                                                                                                                      |
| `REIKA_MODEL`        | _required_                 | Model name, or a comma-separated list of models served by the same `REIKA_BASE_URL`.                                                                                            |
| `REIKA_API_KEY`      | `no-key`                   | Cloud API key (any non-empty for local)                                                                                                                                         |
| `REIKA_PROFILES`     | _unset_                    | Comma-separated names of extra profiles, each defined by `REIKA_<NAME>_MODEL` / `_BASE_URL` / `_API_KEY` (plus optional `_MAX_TOKENS` / `_CONTEXT_WINDOW` / `_MIN_GEN_TOKENS`). |
| `REIKA_MODE_MODELS`  | _unset_                    | Model each mode runs on, as `<mode>=<model\|profile>` pairs: `plan=kimi,grind=qwen3-coder`.                                                                                     |
| `REIKA_DEFAULT_MODE` | `agent`                    | Mode the session starts in: `agent`, `plan`, `vibe`, `minimal`, `grind`, or `chat` (shell isn't a launchable default).                                                          |

- **`REIKA_MODEL`** — First is the default; switch with `/model <name>`
- **`REIKA_PROFILES`** — For a model behind a different endpoint or key. See [Multiple
  models](#multiple-models)
- **`REIKA_MODE_MODELS`** — The mode a turn runs in picks the model, at startup and on every mode
  switch, ahead of the profile the last session saved. A mode with no entry runs the session's own
  model, so leaving a mapped mode brings you back to it. A `/model` you pick by hand outranks the map
  for the rest of the session (`/new` keeps that model, and the map applies again). Values are
  profile names or `REIKA_MODEL` models; an entry naming neither is ignored, with a line at startup.
  `shell` runs no model, so it takes no entry. See [Per-mode models](#per-mode-models)
- **`REIKA_DEFAULT_MODE`** — Unrecognized values fall back to `agent`. `REIKA_PLAN_EXPERIMENT=1`
  is the legacy alias for `plan`; an explicit `REIKA_DEFAULT_MODE` wins

## Context, generation and limits

| Key                      | Default                 | What                                                                                                                                                                                                            |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_CONTEXT_WINDOW`   | _unset_                 | Model context window; denominator for the status-line `ctx` fill gauge and the basis for compaction and the payload cap.                                                                                        |
| `REIKA_MIN_GEN_TOKENS`   | _learned_ (from `2048`) | Generation room reserved from the window.                                                                                                                                                                       |
| `REIKA_MAX_TOKENS`       | _unset_                 | Cap response tokens per call (cloud cost/latency control).                                                                                                                                                      |
| `REIKA_REASONING_ROUNDS` | `2`                     | Recent tool-call rounds that keep their reasoning in context (rest pruned). 1 = leanest; higher avoids re-derivation on thinking models, at a token cost                                                        |
| `REIKA_REPO_MAP_BUDGET`  | scales with the window  | Chars allotted to repo map in system prompt. Unset, 5% of the context window, between 3200 and 12000 (3200 when no window is known); set, it pins the value                                                     |
| `REIKA_MAX_TURNS`        | `400`                   | Tool-call iterations per user turn. A backstop for loops the detectors miss, not a cost cap, sized so a healthy complex turn never hits it. In the TUI ctrl-c is the real cap; in headless this is the only one |

- **`REIKA_CONTEXT_WINDOW`** — Can be overridden per profile. Unset, Reika asks the endpoint
  (`/v1/models`: llama.cpp's `n_ctx`, vLLM's `max_model_len`, floored to the thousand), then the
  models.dev catalog for hosted endpoints. When neither has one, a startup warning says so and the
  gauge shows absolute tokens with no percentage
- **`REIKA_MIN_GEN_TOKENS`** — Drives the per-turn `max_tokens` backstop, the room the payload cap
  reserves, and the compaction trigger. Unset, it starts at 2048 and rises to cover what the model
  actually generates (p90 of the last 16 finished rounds, plus 25%, capped at a quarter of the
  window), so a thinking model earns its own room to think. Setting it pins the value: 6144 gives a
  16k thinking model that room from the first round. Can be overridden per profile. Needs a known
  context window
- **`REIKA_MAX_TOKENS`** — Can be overridden per profile

## Approvals, sandbox and command bounds

| Key                        | Default                 | What                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_AUTO_APPROVE`       | `safe`                  | Approval mode. `safe` (the default; also `true`/`1`) auto-approves edit/write/bash but still prompts for dangerous commands and for any write that lands outside the project directory; `bypass` (or `yolo`) skips all prompts, and refuses out-of-project writes outright since there is no prompt to fall back on; `off` (or `false`/`0`, and what any unrecognized value resolves to) confirms everything. |
| `REIKA_UNATTENDED`         | unset                   | `1` for a TUI session nobody is watching (a long turn left to grind while you're away, or overnight): anything the approval mode would prompt for is declined instead of opening a dialog, and `ask_user` is not offered, the same rule headless follows.                                                                                                                                                     |
| `REIKA_SANDBOX`            | `1` on macOS            | Run model-chosen shell commands under a kernel-enforced local sandbox (Seatbelt, via the system `sandbox-exec` — no bundled dependency).                                                                                                                                                                                                                                                                      |
| `REIKA_BASH_TIMEOUT_MS`    | `1800000`               | Wall-clock ceiling on a single bash command, ms (30 min — a slow build or a full test suite).                                                                                                                                                                                                                                                                                                                 |
| `REIKA_BASH_IDLE_MS`       | `300000`                | Kill a bash command that has written nothing for this long, ms (5 min).                                                                                                                                                                                                                                                                                                                                       |
| `REIKA_REQUEST_TIMEOUT_MS` | `0` (wait indefinitely) | How long the model server may send **nothing at all** before the request is aborted, ms.                                                                                                                                                                                                                                                                                                                      |

- **`REIKA_AUTO_APPROVE`** — Leave it unset to keep `/approvals off` available as a session toggle;
  an explicit `safe` or `bypass` overrides the toggle
- **`REIKA_UNATTENDED`** — The model is told nobody was there to approve, so it carries on without
  the step or leaves it for you. Each turn ends with a `Declined while unattended` notice listing
  what was left, and the prompt's rule on asking becomes "pick the most reasonable reading and name
  each such choice in your final reply". Combines with `REIKA_AUTO_APPROVE` (`off` plus unattended
  declines every edit and command), and does nothing under `bypass`, where nothing prompts. This sets
  the starting state; `/unattended on\|off` switches it mid-session, though whether `ask_user` is
  offered stays as it was at launch. The status bar shows an `unattended` chip
- **`REIKA_SANDBOX`** — Writes are confined to the working directory and the temp and cache dirs.
  Network is denied except for loopback and unflagged `git`/`gh` reads (`gh pr view`, `git fetch`),
  so a local model server, a test suite's own listener and the shipped `/issue` and `/review` skills
  all work. A command the danger scan flags asks you first and, once you approve it, runs
  unsandboxed, which is what lets `npm install` or `git push` work without a proxy. Under `bypass`
  every command is sandboxed, because there is no prompt to fall back on. Reads stay open, since a
  blocklist of secret paths can never be complete. Git metadata is the exception to the writable
  dirs. Git's `config` and `hooks`, and the files that decide which config git reads (anything named `.git`, `commondir` or `gitdir`), are never
  writable, wherever they sit, temp included. That is because `core.fsmonitor` and a hook are
  programs something else runs later: Reika's own `git status` after the next command, or your next
  commit. Deleting them is still allowed, so removing a nested repo works, except for the project's
  own `.git`. The cost is that `git init`, `git clone`, `git submodule add` and `git worktree add`
  all write these files, so creating a repo is a command you run yourself, and a test suite that
  creates repos in a temp dir fails under the sandbox. macOS only: on Linux it reports unavailable
  and behaves as before, since bubblewrap's `--unshare-net` gives the child its own loopback and would block the host's model server. `0`
  disables
- **`REIKA_BASH_TIMEOUT_MS`** — `0` disables
- **`REIKA_BASH_IDLE_MS`** — A hung command (a server, a watcher, a prompt waiting on input) goes
  silent, so this bound catches it without shortening the ceiling for real work. `0` disables
- **`REIKA_REQUEST_TIMEOUT_MS`** — Unset, Reika waits as long as it takes. llama.cpp can send
  nothing while it prefills, and a model streamed off SSD can be silent for a very long time and
  still be working (Node's own default would kill the turn at 300s). Esc cancels a server that really
  is hung. Set a positive value to cap the wait

## Subagents

| Key                        | Default              | What                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SUBAGENT_MODEL`     | _falls back to main_ | Override model for subagents                                                                                                                                                                                                                                                                                        |
| `REIKA_SUBAGENT_BASE_URL`  | _falls back_         | Override server for subagents                                                                                                                                                                                                                                                                                       |
| `REIKA_SUBAGENT_API_KEY`   | _falls back_         | Override key for subagents                                                                                                                                                                                                                                                                                          |
| `REIKA_SUBAGENT_MAX_TURNS` | `10`                 | Subagent round budget. The last round is a report round: every tool is withdrawn and the subagent is told to write up what it has, with a "Not covered" list, so the parent always gets a report, never `(reached max turns…)`.                                                                                     |
| `REIKA_SUBAGENT_PRESSURE`  | `1`                  | Suggests a subagent mid-session: when a `grep`/`glob` result spans 4+ files and reading them would push the request over the compaction threshold, the result gets a one-line footer pointing at `subagent`. It shows up in the tool output at the moment the model decides, rather than as a standing prompt rule. |

- **`REIKA_SUBAGENT_MAX_TURNS`** — Keep it tighter than `REIKA_MAX_TURNS`
- **`REIKA_SUBAGENT_PRESSURE`** — Once per turn, and never inside a subagent. Preferred over
  `REIKA_SUBAGENT_NUDGE`, which sends trace-shaped requests to a subagent from the first round and
  pays for that run whether or not the parent was short of room. Needs a known context window (without one there is no
  threshold to measure against), so in a session with no window it never fires. `0` turns it off, as
  a baseline for A/B runs

## Images

| Key                     | Default      | What                                                                                                                                                                                                             |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_VISION`          | describe     | Pasted images. `describe` (the default) turns the image into text first, with a vision model or system OCR; `native` sends the image itself to the model as a multimodal part, for a model that can already see. |
| `REIKA_VISION_MODEL`    | _unset_      | Vision model for pasted/dragged-in images.                                                                                                                                                                       |
| `REIKA_VISION_BASE_URL` | _falls back_ | Override server for the vision model                                                                                                                                                                             |
| `REIKA_VISION_API_KEY`  | _falls back_ | Override key for the vision model                                                                                                                                                                                |
| `REIKA_OCR_LANGS`       | _unset_      | Preferred languages (BCP-47, comma-separated) for OCR of pasted images, e.g. `en-US,ja-JP`.                                                                                                                      |

- **`REIKA_VISION`** — Can also be set per profile, as `REIKA_<NAME>_VISION`, since it is a property of the
  model, not the machine. `native` sends the image once, for the turn it was pasted in, and history
  keeps a short note in its place saying it was not transcribed.
- **`REIKA_VISION_MODEL`** — When set, this model describes images instead of system OCR. The
  description reaches the main model as text, so the main model can stay text-only. It is used for
  nothing else
- **`REIKA_OCR_LANGS`** — Unset uses the platform recognizer's default. Windows uses only the
  first entry

## Web tools

| Key                           | Default | What                                                                                                              |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `REIKA_SEARXNG_URL`           | _unset_ | SearXNG instance URL (self-hosted, local-first); enables the `search` tool when CDP search is not in use.         |
| `REIKA_CDP_SEARCH`            | _auto_  | Drive a real Chrome over CDP for `search`.                                                                        |
| `REIKA_CDP_PORT`              | `9222`  | Chrome remote-debugging port for the above.                                                                       |
| `REIKA_CHROME_PATH`           | _unset_ | The Chrome/Chromium binary for CDP search and `reika web --window`, instead of a search of the usual paths        |
| `REIKA_PASTE_FETCH`           | `ask`   | Fetch `http(s)` URLs pasted into a prompt before the turn runs (up to 2, 8k chars each): `ask`, `apply` or `off`. |
| `REIKA_MAX_SEARCHES_PER_TURN` | `3`     | Cap `search` calls per user turn (prevents runaway / quota burn)                                                  |
| `REIKA_MAX_FETCHES_PER_TURN`  | `5`     | Cap `fetch_url` calls per user turn                                                                               |

- **`REIKA_SEARXNG_URL`** — `fetch_url` is registered either way
- **`REIKA_CDP_SEARCH`** — Drives a real Chrome over CDP for `search`; unset means **auto**. Three
  things to know:
  - **When it is on** — On macOS it is used whenever Chrome or Chromium is installed. Elsewhere it
    is off, because the launch opens a visible window that takes focus. `1` opts in on any platform
    (and fails loudly without a browser); `0` turns it off.
  - **Which provider wins** — It **takes priority over `REIKA_SEARXNG_URL` whenever it is in use**,
    and a startup line names the winner when both are configured. SearXNG reaches search engines as
    a bare HTTP client, which is exactly what they CAPTCHA, while a browser on a persistent profile
    keeps getting served.
  - **What it launches** — Nothing until the first search, since detection only checks that the
    binary exists. Then it starts a separate instance in the background on its own profile at
    `~/.config/reika/chrome`. It is never focused on macOS and never headless (a fresh headless
    profile is what gets challenged), and it is reused across searches and shuts down after 10 idle
    minutes
- **`REIKA_CDP_PORT`** — An instance already listening here is reused rather than relaunched
- **`REIKA_PASTE_FETCH`** — A link that is the whole request is fetched without asking; any other link gets a confirm first. `ask` (the default) asks in the TUI and leaves the link alone in headless runs. `apply` (also `1` or `true`) still asks in the TUI but fetches without asking in headless runs. `off` never fetches, and any value Reika doesn't recognize, `0` included, counts as `off`, since each pasted link is an outbound request. See [Pasted URLs](skills.md#pasted-urls)

## Skills and prompts

| Key                | Default                  | What                                                                                                                                                      |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SKILLS_DIR` | `~/.config/reika/skills` | Directory of `*.md` skill files, each of which becomes a slash command.                                                                                   |
| `REIKA_SKILL_AUTO` | `ask`                    | What a command-shaped skill match may do to your prompt.                                                                                                  |
| `REIKA_ASK`        | `1`                      | The `ask_user` tool: the model can put one multiple-choice question to you mid-turn instead of guessing when what it read contradicts what you asked for. |

- **`REIKA_SKILLS_DIR`** — A skill of the same name in `<cwd>/.reika/skills/` wins over it. See
  [Skills](skills.md#skills-reusable-prompt-templates)
- **`REIKA_SKILL_AUTO`** — `ask`: the TUI asks before sending, with two rows (`Send as typed`,
  selected, and `Apply /review`); headless (`-p`) sends the prompt as typed. `apply` (also `1`): the
  TUI still asks, and headless applies a strong match without asking, on prompts of 12 words or
  fewer. `off`: only the one-line hint. See [Skills](skills.md#skills-reusable-prompt-templates)
- **`REIKA_ASK`** — `0` removes the tool, along with the lines in the agent and plan prompts about
  asking

## MCP servers

| Key                 | Default | What                                                                                               |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `REIKA_MCP_SERVERS` | _unset_ | MCP servers to run alongside the session, as JSON or as the path of a JSON file.                   |
| `REIKA_MCP`         | `1`     | `0` turns configured MCP servers off for the session, for example to measure behavior without them |

- **`REIKA_MCP_SERVERS`** — Three document shapes are accepted: the standard `{"mcpServers":
{"name": {"command": …}}}`, that map without the wrapper, and a list of `{"name": …,
"command": …}`. Each entry is `command` plus optional `args`, `env`, `cwd`, `timeoutMs` (per
  call, default `60000`) and `connectTimeoutMs`
- **Handshake timeout** — `connectTimeoutMs` bounds the handshake (`server/discover` or
  `initialize`, then `tools/list`) and defaults to 15000. It is separate because it is paid before
  anything else: a server that hangs at startup must not hold up the session, and one behind a cold
  `npx` install can need longer than the default to answer
- **Transport** — Reika speaks MCP's **stdio** transport (JSON-RPC 2.0, newline-framed) in both
  protocol eras: `2026-07-28` to a server that answers `server/discover`, and otherwise the
  `initialize` handshake (`2025-11-25` back to `2024-11-05`). Then come `tools/list` (paginated)
  and `tools/call`
- **Environment** — A server inherits only `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`,
  `TMPDIR` and the locale from Reika's environment, never its API keys, so give it anything else
  through `env`
- **Tools** — Every tool it finds joins the **agent** tool list as `mcp__<server>__<tool>` and
  becomes a `/<server>:<tool>` slash command; `/mcp` lists them. Agent mode only: Reika can't see
  what an MCP tool does, so plan, chat, minimal and grind never get one: each makes a promise that
  rests on its tool list (plan can't change files, chat has no filesystem, minimal and grind have a
  fixed set of tools)
- **Approval** — A tool call goes through the approval gate with no danger warnings: under `safe`
  it runs, under `off` it asks, and under `bypass` it runs without asking. Set `"approve": "always"`
  on a server whose tools send data somewhere, and every call from it asks even under `safe` (it is
  refused under `bypass` and declined when unattended). Leaving `approve` out, or writing `"auto"`,
  gives the ordinary behavior; any other value, such as a typo like `"alway"`, is reported as a
  config error
- **Failure** — A server that fails to start is reported at startup and skipped, and the session
  opens anyway. Stdio only; remote HTTP/SSE servers are not supported

## Diagnostics

| Key                      | Default                             | What                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_DEBUG`            | _unset_                             | Any non-empty value writes diagnostics to a log file: session-start bundle size, the loop and spiral detectors, grounding, prefix-cache classification with the prefill cost it implies, per-round entropy/KL drift and more. |
| `REIKA_DEBUG_FILE`       | _unset_                             | One file for the `REIKA_DEBUG` log instead of one per session. Always appended to and never cleaned up, so use it when an experiment should accumulate across runs                                                            |
| `REIKA_ENTROPY`          | _unset_                             | `1` asks the server for per-token logprobs, so the `REIKA_DEBUG` drift lines report the model's real predictive entropy (and how surprised it was by its own output) instead of the entropy of the text alone.                |
| `REIKA_TSCONFIG`         | _unset_                             | Overrides the tsconfig the post-edit typecheck uses (relative to cwd, or absolute).                                                                                                                                           |
| `REIKA_SPILL_STATS`      | _unset_                             | `1` appends one JSON line to a stats file for each over-cap tool result, and for each call that opens a saved result file.                                                                                                    |
| `REIKA_SPILL_STATS_FILE` | `~/.config/reika/spill-stats.jsonl` | Path for the `REIKA_SPILL_STATS` file. Always appended to: unlike the debug log, it is meant to accumulate across sessions                                                                                                    |

- **`REIKA_DEBUG`** — Goes to a **file**, never stderr, which would corrupt the TUI. Each session
  writes its own log to `~/.config/reika/logs/`, named like its auto-save under `history/` so the
  two pair up (the log's `session file=` line names the transcript, including after `/new` and
  `/resume`). `~/.config/reika/logs/latest.log` always points at the current session's log. At
  startup, logs older than 60 days are deleted, and then the oldest of the rest while the directory
  holds more than 50MB; a running session's log is never deleted. To keep logs for every session,
  put `REIKA_DEBUG=1` in `~/.config/reika/.env`. The log quotes your task and includes the paths and
  commands the session ran, the same content as the auto-save
- **`REIKA_ENTROPY`** — Needs `REIKA_DEBUG`, since the log is the only thing that reads it, and
  makes the streamed response much larger (top-5 candidates per token). The per-round entropy/KL
  lines are written either way; this only sharpens the entropy half. A server that rejects the
  fields is retried once without them, so it can't cost a turn
- **`REIKA_TSCONFIG`** — For layouts auto-detection can't work out, such as references-only roots
  or projects with only named variants (`tsconfig.web.json` and the like) and no plain
  `tsconfig.json`. Normally detected by walking up from the edited file to the nearest
  `tsconfig.json`
- **`REIKA_SPILL_STATS`** — Records sizes and tool names only, never output. A measurement, not a
  feature: an eval can show that the model follows a saved-file pointer, but only real use shows
  what share of your `bash` calls exceed the 64KB cap at all, which decides whether the retained
  window is sized right. Off by default, and it changes no behavior while it runs

## Loop breaking and context management

| Key                         | Default           | What                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_COMPACTION_REPORT`   | `1`               | A report round before each compaction fold: one extra model call with tools withdrawn asks for a short _compaction note_: what the model has established (file paths, function names, quoted strings) and what is still open. The fold then carries that note as the body of its recap, instead of just the list of reads.                                                                                                                         |
| `REIKA_NOTE_PREFILL`        | `1`               | On a local or private host, the compaction note's reply is started for the model (`Compaction note N` / `Established:`) so it continues a note instead of calling a tool. If an engine rejects this, it stays off for that endpoint. `0` turns it off.                                                                                                                                                                                             |
| `REIKA_CONTINUE`            | `1`               | Carries a reasoning block cut off mid-thought forward instead of discarding it and asking the model to start over.                                                                                                                                                                                                                                                                                                                                 |
| `REIKA_CONTINUE_TAIL_CHARS` | `6000`            | How much of the cut-off block comes back (default `6000` ≈ 1500 tokens).                                                                                                                                                                                                                                                                                                                                                                           |
| `REIKA_CONTINUE_MAX`        | `3`               | Consecutive continuations allowed without progress, where progress is a tool call or a committed answer (default `3`).                                                                                                                                                                                                                                                                                                                             |
| `REIKA_DROPPED_LEDGER`      | `1`               | Tells the model, once per request, that some tool results above show only a summary line because their output was dropped to make room. That is a context limit, not a failed command, and not a result it already handled.                                                                                                                                                                                                                        |
| `REIKA_DEDUP_PAYLOADS`      | `1`               | Replaces a tool result that repeats an earlier one byte for byte (a trail of summaries like `Read A / Read A / Read A`, or two identical reads in one round) with a short stub pointing back at the first copy.                                                                                                                                                                                                                                    |
| `REIKA_PREFIX_STABLE`       | `1` with a window | Keeps requests append-only between the points where context is shrunk, so the engine's prompt cache stays valid. Tool output stays in full and is collapsed in one batch at the compaction threshold instead of every round, and loop and plan nudges go in a trailing note instead of the system prompt.                                                                                                                                          |
| `REIKA_AGE_LOW_FRACTION`    | `0.7`             | How far below the compaction threshold each shrink sheds context under `REIKA_PREFIX_STABLE`, as a fraction (clamped to 0.3–0.95; ignored when that is off).                                                                                                                                                                                                                                                                                       |
| `REIKA_AGE_ARGS`            | `1`               | Lets each shrink under `REIKA_PREFIX_STABLE` also cut old tool-call arguments (an edit's text, a long shell command) down to a short stub, after the older tool output has gone. Their effect is already in the files and the results. `0` turns it off.                                                                                                                                                                                           |
| `REIKA_NOTE_SLOT`           | _unset_           | Where the per-round note goes under `REIKA_PREFIX_STABLE`. Unset, Reika probes a local server and moves the note onto the last tool result when the chat template would hide earlier reasoning behind it (#827). `tool` or `user` forces one.                                                                                                                                                                                                      |
| `REIKA_PRESERVE_THINKING`   | _unset_           | `0` stops sending `chat_template_kwargs: {preserve_thinking: true}` to local servers, reproducing an engine that ignores it. For measuring #827; leave unset.                                                                                                                                                                                                                                                                                      |
| `REIKA_PLAN_HANDOFF`        | `1`               | When a plan moves to agent mode, folds the plan-mode exploration into a single digest, keeping the original request and the written plan verbatim. On a small window, the raw reads and reasoning from planning then don't crowd out the agent's own work and push the plan out of view.                                                                                                                                                           |
| `REIKA_PLAN_BASH`           | `1`               | Registers a **read-only** `bash` in plan (and vibe) mode: commands a strict allowlist can prove read-only (`grep`, `cat`, `head`, `find`, `wc` and similar, and pipelines of them) run. Anything that could write or run something else (redirection, command substitution, `sed`/`awk`, any unlisted command) is refused, with the rule stated.                                                                                                   |
| `REIKA_REASONING_LOOP`      | `1`               | Acts when the model's reasoning goes in circles, re-deriving the same analysis round after round while the tool results look new (measured by 8-gram self-repeat and cross-round similarity). Plan mode then forces the plan to be written; agent mode escalates from a pinned reminder to pausing inspection tools and, if that fails, an honest stop.                                                                                            |
| `REIKA_WITHDRAW_KEEP_TOOLS` | `1`               | While the loop ladder has paused inspection, keeps `read`/`grep`/`glob`/`list` in the offered tool list and refuses them when called, instead of dropping them. The tool list sits at the start of the prompt, so dropping them re-processes the whole prompt twice per pause.                                                                                                                                                                     |
| `REIKA_READ_FIRST`          | `1`               | The first `edit` to a file whose contents are not in the model's context (never read, or the read has since aged out) is held back once with an instruction to read the file, so a guessed `old_string` never gets the chance to fail and spiral.                                                                                                                                                                                                  |
| `REIKA_READ_FIRST_EXACT`    | `1`               | Lets an `edit` past the read-first gate when its `old_string` is 24 or more characters and matches the file exactly and uniquely, since those bytes are not a guess. `0` holds it back like any other unread edit, the baseline for `evals/fixtures/22-read-first-exact`.                                                                                                                                                                          |
| `REIKA_PLAN_VERIFY`         | `1`               | Grounds a finalized plan against the codebase: paths and backticked identifiers it names are checked (paths by `stat`, symbols by a bounded tree walk) and any not found are appended as a "may be new" note the agent turn inherits. That heads off an agent hunting with greps that match nothing, or edits whose `old_string` is in no file.                                                                                                    |
| `REIKA_PLAN_ALIGN`          | `1`               | Builds on the always-on step checklist: during implementation the checklist is pinned into the system prompt every round, and a turn that stops with observable steps unchecked is sent back once (anything left after that is waived, not asked again).                                                                                                                                                                                           |
| `REIKA_LOGIT_RECOVERY`      | `1`               | Before stopping a reasoning loop, tries one last round with a mild one-off `logit_bias` (−4, capped, tool-name tokens exempt) that down-weights the loop's own recurring tokens. llama.cpp only (it needs the native `/tokenize` endpoint) and inactive under `REIKA_REASONING_LOOP=0`. If it doesn't help, the turn stops as it would have.                                                                                                       |
| `REIKA_CONVERGE_RETRY`      | `1`               | In plan and agent mode, makes one steered retry before giving up: a strong instruction naming the failure ("you looped and kept re-questioning yourself; commit to one analysis and do it") instead of stopping cold.                                                                                                                                                                                                                              |
| `REIKA_VERBATIM_ABORT`      | `1`               | Cuts a single runaway reasoning block mid-stream instead of letting it run to the `max_tokens` limit. It cuts on a self-repeat ratio that tightens as the block grows, or on an absolute length ceiling for spirals that circle without repeating words. A length cut with little repetition is carried forward like a token-limit cut (`REIKA_CONTINUE`); a degenerate one recovers by mode (plan mode writes the plan, agent mode gets a nudge). |
| `REIKA_CONTENT_SPIN`        | `1`               | Cuts a reply that repeats itself almost word for word in its visible output (ratio ≥0.8 past 16,000 chars) rather than letting it run to the `max_tokens` limit. Stricter than the reasoning cut: content is the deliverable, and a long table or switch-heavy code repeats its shape legitimately. The round is discarded and retried with a notice naming the repetition. `0` turns it off.                                                      |
| `REIKA_SELF_AWARE`          | `1`               | One line in the agent and plan prompts saying the model runs inside reika, with the paths to the shipped `docs/`, the skills directories and the saved sessions. It is scoped to questions about Reika itself, so it doesn't pull the model into those paths otherwise.                                                                                                                                                                            |
| `REIKA_CALLER_CHECK`        | `1`               | One agent-prompt rule: after changing what a function accepts, returns or throws, find and read every caller and fix any the change breaks.                                                                                                                                                                                                                                                                                                        |
| `REIKA_SPILL`               | `1`               | Saves an over-cap `grep`/`glob`/`bash` result to a temp file for the session and adds its path to what the model sees, so the part the cap drops stays reachable. The model reads the file with `read` or `grep` instead of re-running the search or command.                                                                                                                                                                                      |

- **`REIKA_COMPACTION_REPORT`** — Notes are numbered per session, and each one replaces the last;
  there is one retry if the reply carried no note. `0` goes back to a recap that only lists reads.
  Measured: without it, a model that had every file it needed by round 6 folded five times and
  re-read them after each fold; with it, the same prompt took 11 rounds and 1 fold and got a correct
  answer
- **`REIKA_NOTE_PREFILL`** — The first attempt at the note ends the request with the opening of
  the reply already written. A small model asked for a note after a long run of tool calls tends to
  make another call instead: LFM2.5 did on every measured fold, despite the instruction and a retry
  that refused the call, yet it continued a started note every time. The reasoning block is skipped.
  Hosted APIs never get it
- **`REIKA_CONTINUE`** — The trimmed **tail** of the block is moved into the reply (`content`),
  followed by a nudge to resume. It has to move because a chat template renders earlier
  `reasoning_content` as nothing, which is why the old retry lost work that was sitting in history.
  Whether a block continues depends on its self-repeat **ratio**, not on which cut fired: the
  `max_tokens` limit and `REASONING_HARD_CEIL` landed 5.4% apart on a measured run, so both go
  through the same check, and a genuinely degenerate block is still discarded. Applies in agent mode
  and plan exploration, never on the round that writes the plan, whose tighter ceilings are there to
  catch a spiral. Set `0` for a run measuring context use or eviction, since a carried tail changes
  what a request holds
- **`REIKA_CONTINUE_TAIL_CHARS`** — A cut-off block's conclusion sits at its **end**, so keeping
  the tail keeps the payoff and drops the earlier circling. A longer tail helps less and less while
  its cost grows steadily, since it sits in the next round's prompt and eats the generation room the
  continuation needs. On a small window, more is not better
- **`REIKA_CONTINUE_MAX`** — Resets on progress, so there is no limit on how often a session may
  continue, only on continuing without producing anything. A novelty check also stops a
  continuation that merely restates the previous one
- **`REIKA_DROPPED_LEDGER`** — Without it, a dropped result reads like a success: on a `/review`
  run the model rebuilt a diff from memory and only afterwards doubted itself, while with the notice
  the same situation produced "the output got dropped, let me re-run it". It is one line per request
  rather than a note on each message (per message measured about 19% of a long turn's request), and
  appears only when something really was dropped, so it never claims a loss that didn't happen. It
  goes at the end of the system prompt, or in the trailing note under `REIKA_PREFIX_STABLE`. `0`
  turns it off
- **`REIKA_DEDUP_PAYLOADS`** — Deterministic, and it keeps the first copy; the room a stubbed copy
  frees goes to the rest. It is skipped whenever `REIKA_PREFIX_STABLE` is active, because turning a
  later duplicate into a stub would rewrite earlier bytes and invalidate the prompt cache. So with a
  context window set it changes nothing. It only affects sessions with no `REIKA_CONTEXT_WINDOW` or
  with `REIKA_PREFIX_STABLE=0`, where older tool output is already collapsed to summaries and earlier
  bytes are rewritten every round anyway. `0` turns it off
- **`REIKA_PREFIX_STABLE`** — Cuts per-round prompt re-processing on llama.cpp, especially for
  SWA/hybrid-memory models, which re-process the whole prompt on any change to the part of the prompt the engine has cached. The cost
  is a fuller context between shrinks. One edit mid-context re-processed 8453 tokens, 7.9 min at
  22.9 tok/s, against 25 tokens for an append. Inactive without `REIKA_CONTEXT_WINDOW` (or a window
  the endpoint reports). Takes precedence over `REIKA_DEDUP_PAYLOADS`. `0` goes back to collapsing
  output every round
- **`REIKA_AGE_LOW_FRACTION`** — Each shrink re-processes most of the prompt, so a lower value
  means fewer of them per run (three were about 24 minutes of a 2h15m run), at the cost of less live
  context between them. It is a knob for measuring that trade (`evals/prefixcost-report.ts`), not a
  setting with a known better value
- **`REIKA_AGE_ARGS`** — In a replay of saved sessions it cut folds by a fifth at a 24k window and by
  a third at 32k, with re-reads unchanged; a small A/B on a local 35B model pointed the same way.
  A new call that copies a stub is not run, and the model is told to send the real text;
  `REIKA_DEBUG` logs `age-args-echo` when that happens
- **`REIKA_PLAN_HANDOFF`** — `0` turns it off
- **`REIKA_PLAN_BASH`** — Plan mode still cannot change the repo; the guarantee now comes from the
  allowlist rather than from the tool being absent. `0` removes the tool and reverts the plan prompt
- **`REIKA_REASONING_LOOP`** — Detection always runs and feeds the debug log; `0` turns off only
  the response
- **`REIKA_WITHDRAW_KEEP_TOOLS`** — Measured on lfm2.5 (#867): prefill per round down by a third,
  and fewer refused calls per pause, not more. `0` removes the paused tools from the list instead
- **`REIKA_READ_FIRST`** — If the model just re-issues the edit, it applies as-is, and it costs at
  most one extra round per file per turn. Under `REIKA_DEBUG` each hold logs `would-land=yes\|no`:
  whether the held edit would have applied, which shows how often the gate cost a round versus caught
  a guessed edit. An `old_string` of 24 or more characters that matches the file exactly and
  uniquely isn't held back, and logs `read-first proven` instead. `0` turns it off
- **`REIKA_PLAN_VERIFY`** — Advisory only, and it errs toward flagging too little rather than too
  much. `0` turns it off
- **`REIKA_PLAN_ALIGN`** — `0` turns it off (the checklist itself stays)
- **`REIKA_LOGIT_RECOVERY`** — `0` turns it off
- **`REIKA_CONVERGE_RETRY`** — One retry at most, so the worst case is unchanged: the same stop
  fires once it is spent. `0` turns it off
- **`REIKA_VERBATIM_ABORT`** — The only thing that stops a single never-ending block before the
  token limit. `0` turns it off
- **`REIKA_CONTENT_SPIN`** — The reply-side counterpart of `REIKA_VERBATIM_ABORT`. The reasoning
  detectors read only the `reasoning` stream, so a reply that looped in `content` ran to the token
  limit and only then got the length retry. There is no length ceiling on content, since long,
  distinct output is not a sign of a loop and `max_tokens` already bounds it. One recovery per turn;
  after that the repeat runs to the limit. At every check the `content-spin` debug line records
  `ratio`, `window`, `chars` and `fence` (whether the cut landed inside a code fence), which is what
  a threshold change has to be re-checked against; `evals/contentspin-replay.ts` replays saved
  sessions through the check. `0` turns it off
- **`REIKA_SELF_AWARE`** — Never names the `.env` (API keys) or the binary. `0` removes the line
- **`REIKA_CALLER_CHECK`** — Grind mode's step 6 on its own. On the chunk fixtures
  deepseek-v4.1-flash went from 4/10 to 10/10 with it, a local 27B started searching for callers
  (0/3 → 2/3 runs), and it added no calls on fixtures without callers. Agent mode only. `0` turns it
  off
- **`REIKA_SPILL`** — Adds no tool and no schema; the saved path points at tools the model already
  has. If the file can't be written, the ordinary capped result is returned, and when off it changes
  nothing at all. `bash` is the case where the _end_ matters: it used to stop reading at the cap, so
  a long build or test run lost the failure at the end. Now the model's copy keeps the start and a
  bounded 4MB window keeps the end. `fetch_url` saves every page over 2KB, not just over-cap ones,
  and puts the path in the summary too. What cuts a fetched page is usually the context window, not
  the tool cap, and the marker at that cut says to read a narrower range, which is only possible once
  the page is a local file. A URL fetched again in the same session is served from that file with no
  request and no budget use, and the compaction recap lists saved pages by path, so a page the
  session already read stays reachable through every fold. Tested on a 2300-file monorepo, where
  `**/*.ts` matched 560 files and the 200-path page covered 3 of 5 packages. A small repo never shows
  that, since a cap it never reaches behaves exactly as if the flag were off. `0` disables (also the
  A/B baseline)

## Terminal

| Key                   | Default | What                                                                                                                                                                                                           |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SYNC_OUTPUT`   | `1`     | Wraps every Ink frame in one synchronized write (DEC mode 2026) so the terminal paints it atomically.                                                                                                          |
| `REIKA_INPUT_FLOOR`   | `1`     | Experimental. Keeps the input box on the terminal's bottom rows: the live frame fills the screen from startup and never gets shorter than the space it holds. `0` restores the frame that follows its content. |
| `REIKA_BASIC_GLYPHS`  | auto    | Draws the UI with glyphs a basic console font carries (`●`, `└`, `│`, square borders, an ASCII spinner) in place of the ones it lacks (`⏺`, `↳`, `▎`, rounded borders, braille).                               |
| `REIKA_WORKING_WORDS` | `1`     | Rotates garden and perfumery verbs on the busy line ("Blooming…", "Steeping…"); `0` shows "Working". The web page follows it too.                                                                              |

- **`REIKA_SYNC_OUTPUT`** — Ink paints a frame by erasing and redrawing, in three separate writes
  when a message moves into scrollback. If the process is swapped out between them under memory
  pressure (a large local model on a small machine), the terminal shows the erased state as flicker.
  iTerm2, kitty, WezTerm, Ghostty, Alacritty, foot, Windows Terminal, VS Code and tmux ≥
  3.3 honor the mode; others ignore it harmlessly. `0` restores plain writes
- **`REIKA_BASIC_GLYPHS`** — Auto turns it on for `TERM=linux` (the Linux console) and `vt*`; `1`
  forces it for a terminal auto misses, such as an old Windows console font; `0` keeps the full set.
  Colors step down on their own: a 16-color terminal gets a named-color palette instead of the
  pastels, and `FORCE_COLOR=1` forces that palette where color detection guesses too high (an ssh
  session that inherited `COLORTERM`)

## Experimental flags

These features are still being trialled, and all are **off by default** in code (set `1` to
enable). [`.env.example`](../.env.example) turns on every flag in the table below except
`REIKA_ANON` and `REIKA_SUBAGENT_NUDGE` (the nudge is superseded by `REIKA_SUBAGENT_PRESSURE` above). The rest are
worth enabling for a better experience now, and become defaults once tested further. That is what
happened to `REIKA_SPILL`, `REIKA_PLAN_HANDOFF`, `REIKA_SUBAGENT_PRESSURE`, `REIKA_PLAN_VERIFY`,
`REIKA_PLAN_ALIGN`, `REIKA_LOGIT_RECOVERY`, `REIKA_CONVERGE_RETRY` and `REIKA_VERBATIM_ABORT`, which
is why they sit in the table above rather than here. The "Loop breaking & spiral handling", "Modes"
and "Context management" sections of [`AGENTS.md`](../AGENTS.md) have the full reasoning. These
flags mostly matter for small or quantized local models; on a strong cloud model they add little
(and a couple cost a little).

| Key                    | What `1` does                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_SUBAGENT_NUDGE` | Adds one routing rule to the agent prompt (rule 3, next to the grep rule): a request to trace, explain or summarize how something works across several files goes to `subagent` as the very first call, with the paths and symbols the model already knows, so those reads land in the main context as one digest instead of many separate results. |
| `REIKA_URL_GROUNDING`  | Fetches the http(s) URLs a write, edit or finished plan introduces, on the model's behalf, and appends a ✓/✗ result, catching a plausible but wrong link that would otherwise fail silently at runtime.                                                                                                                                             |
| `REIKA_WARM`           | Warms the KV cache ahead of time: the first keystroke of a prompt sends a throwaway 1-token request with the exact prefix the real request will send (system prompt and history), so a llama.cpp-style server fills its cache while you type and the real request only processes your message.                                                      |
| `REIKA_ANON`           | Replaces your own git author name/email and your GitHub/GitLab/HuggingFace account slug with `<user>`/`<email>` in the scrollback and in saved transcripts, for screenshots and shared logs.                                                                                                                                                        |

- **`REIKA_SUBAGENT_NUDGE`** — Questions about one or two files are still read directly. It covers
  exploration only; the tool and its own trigger text are unchanged. When off, the prompt is
  byte-identical, so it compares cleanly in A/B runs
- **`REIKA_URL_GROUNDING`** — At most 2 URLs per call, each checked once per turn, and safe offline:
  a URL that gets no response is called dead only when another URL in the same batch got through.
  Only a 404/410 or a name that doesn't resolve counts as a dead link; a refusal (401/403/429), a
  server error, and a 404 from a code host (a private repo) or an API path are reported as
  unverified instead. It never fetches a URL carrying a secret (userinfo, a token, key or signature
  query parameter, a webhook), an internal or reserved name, or a host that resolves to a private
  address, and it leaves the last two fetch slots of each turn to the model
- **`REIKA_WARM`** — A failed warm-up costs nothing but a token, and it is skipped when the next
  turn would compact. Best on local setups with slow prefill; a needless (tiny) cost on paid APIs
- **`REIKA_ANON`** — Your identity is looked up once at startup (git config, remotes, and the
  author lines in recent commits) and replaced as exact strings. Third-party owners like
  `anthropics/` or `Qwen/` are left alone, because a pattern over `owner/repo` cannot tell yours from
  theirs. Display only: the model still receives everything verbatim

## Multiple models

There are two ways to expose more than one model, and they compose.

**Same base URL (e.g. a model router).** Just list the models in `REIKA_MODEL`, comma-separated.
They all share `REIKA_BASE_URL`/`REIKA_API_KEY`; the first is the default, and the rest are
switchable with `/model <name>`, with no extra env vars to add or remove as your router's
catalogue changes:

```ini
REIKA_BASE_URL=http://localhost:9931/v1
REIKA_MODEL=qwen3-coder,kimi-k2,glm-4.6   # /model kimi-k2 to switch
```

A router has to forward the stream as it arrives. One that reads fixed-size blocks holds it back, so
text arrives in lumps and the prefill progress on the busy line never shows.

**Different endpoints/keys — named profiles.** When a model lives behind a different base URL or API
key, define a full profile and switch between them at runtime with `/model <name>`:

```ini
# Default profile (existing keys — always available as "default")
REIKA_MODEL=qwen3.5-9b
REIKA_BASE_URL=http://localhost:9931/v1
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

Per-profile `_MAX_TOKENS`, `_CONTEXT_WINDOW` and `_MIN_GEN_TOKENS` fall back to the global values
when unset. When a context window is known, `max_tokens` is computed each turn as the room actually
left (`window − prompt − margin`), capped by `REIKA_MAX_TOKENS` if you set one. So you usually don't
need `_MAX_TOKENS` at all; size `_MIN_GEN_TOKENS` instead to reserve room to think. If you _do_ pin
`_MAX_TOKENS`, **set it generously**: a value low enough to cut a tool call off mid-JSON breaks it
silently, and reasoning models (DeepSeek-R1, Kimi K2) need extra headroom because the thinking counts
toward the cap.

Then in-session:

- `/model` — show the current selection and list available models (default base URL) and named profiles
- `/model kimi-k2` — switch to a model on the default base URL (model name only swaps)
- `/model kimi` — switch to a named profile (model + endpoint + key swap as a unit)
- `/model some-new-model` — a name that isn't in your config still switches, using the current base URL and key, so you can try a model without touching `.env`. The switch message and picker mark it `(not in config)`
- `/new` — starts a new conversation on the same model

Conversation history carries across switches; if the models' styles clash, run `/new` first. The
token counter keeps adding up across models and profiles, so the session has one total.

The selection persists: the next session opens on the profile you last switched to (see [Last
session state](#last-session-state)).

### Per-mode models

`REIKA_MODE_MODELS` ties a model to a mode, so switching mode switches the model too, with no
`/model` each time. For example, a big model to plan, a careful one to grind, a cheap one for chat:

```ini
REIKA_MODEL=qwen3.5-9b                    # the session's own model
REIKA_PROFILES=kimi
REIKA_KIMI_MODEL=kimi-k2.6
REIKA_KIMI_BASE_URL=https://api.moonshot.ai/v1
REIKA_KIMI_API_KEY=sk-...
REIKA_MODE_MODELS=plan=kimi,chat=qwen3.5-9b
```

Each value is anything `/model <name>` accepts: a named profile, or one of `REIKA_MODEL`'s models
(which uses the profile that serves it). The modes are `agent`, `plan`, `vibe`, `minimal`,
`grind` and `chat`; `shell` runs no model, so it takes no entry.

What it does, in order:

1. **At startup** the start mode's model wins over the profile the last session saved. A launch
   `REIKA_MODEL=x reika` still wins over both, because it names the model for _this_ session and
   redefines the default profile. `REIKA_DEFAULT_MODE=plan reika` picks the mode, not the model, so plan's own
   model is what it runs.
2. **On a mode switch** the new mode's model applies. A mode with no entry of its own returns to the
   session's own model (the profile it opened on), so `plan → agent` is a round trip rather than a
   one-way switch onto the plan model.
3. **A `/model` you pick by hand outranks the map for the rest of the session**: from then on, mode
   switches leave the model where you put it. `/new` keeps that model as the session's own, and the
   map applies over it again.
4. Headless (`-p --mode=plan`) honors it too, since there is no `/model` there: the config decides.

## Last session state

Reika remembers the mode and profile you last used in `~/.config/reika/state.json` and opens the
next session on them, so a `/model kimi`, `/plan` or chat mode carries over without touching `.env` (shell mode is
not remembered: the next session opens in the mode before it). When it
does, the scrollback says so (`Resumed plan mode and profile 'kimi' (kimi-k2) from the last
session.`). The precedence is:

1. **Given at launch** — `REIKA_MODEL=x reika`, or an `export` in your shell rc. A model the shell
   hands Reika is what _this_ session should run, and beats everything below.
   `REIKA_DEFAULT_MODE=plan reika` names the mode instead: it picks the mode, and that mode's own
   model from the next line comes with it.
2. **The start mode's model** — `REIKA_MODE_MODELS` (see [Per-mode models](#per-mode-models)), when
   the mode has one. That is a deliberate setting for the mode, while the saved profile below is only
   where the last session happened to be.
3. **The last session** — `state.json`.
4. **`.env` files** — `REIKA_DEFAULT_MODE` / `REIKA_MODEL` there are the defaults the saved state overrides.

Only the launchable modes are remembered (agent, plan, minimal, grind, vibe); ending in chat or
shell keeps the last work mode on record. A mode's own model is never saved as a profile: it is
read from `REIKA_MODE_MODELS` again on every launch, so removing an entry puts the session back on
its own model rather than leaving it stuck on that mode's. A saved profile the config no longer has
(a removed `REIKA_PROFILES` entry, or an ad-hoc `/model some-new-model` that was never in `.env`)
falls back to `default` rather than being recreated. `/new` resets the mode to agent, which is
remembered too, and keeps the model. Headless runs (`-p`) neither read nor write the file, since a
script's behavior should follow from its env, not from the last interactive session. Delete the file
to forget.
