# Reika

Minimalistic coding-agent CLI tuned for small local models. Built on TypeScript + Ink, OpenAI-compatible APIs, with a focus on context discipline.

## Status

Reika is currently experimental but is stable for proper use.

Initially built as a research project exploring how lean a coding agent can be while still being usable on local 3B–9B models and scaling cleanly to cloud models when needed.

Primarily tested on 8B/9B (dense), 20B (MoE), and 35B (MoE) local models with low quantization (Q2-Q4) via llama.cpp and MLX.

## Note

Although Reika can work with smaller models, the output and quality will vary during agentic coding compared to pure chat.

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

`.env` keys (see `.env.example`):

| Key                           | Default                     | What                                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REIKA_BASE_URL`              | `http://localhost:11434/v1` | OpenAI-compatible endpoint                                                                                                                                                                                                                                                   |
| `REIKA_MODEL`                 | _required_                  | Model name                                                                                                                                                                                                                                                                   |
| `REIKA_API_KEY`               | `no-key`                    | Cloud API key (any non-empty for local)                                                                                                                                                                                                                                      |
| `REIKA_MAX_TURNS`             | `12`                        | Tool-call iterations per user turn                                                                                                                                                                                                                                           |
| `REIKA_REPO_MAP_BUDGET`       | `3200`                      | Chars allotted to repo map in system prompt                                                                                                                                                                                                                                  |
| `REIKA_AUTO_APPROVE`          | `false`                     | Skip the approval prompt for edit/write/bash                                                                                                                                                                                                                                 |
| `REIKA_SUBAGENT_MODEL`        | _falls back to main_        | Override model for subagents                                                                                                                                                                                                                                                 |
| `REIKA_SUBAGENT_BASE_URL`     | _falls back_                | Override server for subagents                                                                                                                                                                                                                                                |
| `REIKA_SUBAGENT_API_KEY`      | _falls back_                | Override key for subagents                                                                                                                                                                                                                                                   |
| `REIKA_SUBAGENT_MAX_TURNS`    | `6`                         | Subagent iteration limit                                                                                                                                                                                                                                                     |
| `REIKA_MAX_TOKENS`            | _unset_                     | Cap response tokens per call (cloud cost/latency control). Per-profile override available                                                                                                                                                                                    |
| `REIKA_CONTEXT_WINDOW`        | _unset_                     | Model context window; denominator for the status-line `ctx` fill gauge. Per-profile override available. Unset shows absolute tokens, no %                                                                                                                                    |
| `REIKA_MIN_GEN_TOKENS`        | `2048`                      | Generation room reserved from the window. Drives the per-turn `max_tokens` backstop, the payload cap reserve, and the compaction trigger. Per-profile override. ~2048 reasoning-off; 6144–8192 reasoning-on (set 6144 on a 16k thinking model). Needs `REIKA_CONTEXT_WINDOW` |
| `REIKA_REASONING_ROUNDS`      | `2`                         | Recent tool-call rounds that keep their reasoning in context (rest pruned). 1 = leanest; higher avoids re-derivation on thinking models, at a token cost                                                                                                                     |
| `REIKA_SEARXNG_URL`           | _unset_                     | SearXNG instance URL (self-hosted, local-first). Takes precedence over Tavily                                                                                                                                                                                                |
| `REIKA_TAVILY_API_KEY`        | _unset_                     | Tavily key — free at [tavily.com](https://tavily.com), enables `search` + `fetch_url`                                                                                                                                                                                        |
| `REIKA_MAX_SEARCHES_PER_TURN` | `3`                         | Cap `search` calls per user turn (prevents runaway / quota burn)                                                                                                                                                                                                             |
| `REIKA_MAX_FETCHES_PER_TURN`  | `5`                         | Cap `fetch_url` calls per user turn                                                                                                                                                                                                                                          |
| `REIKA_BASH_TIMEOUT_MS`       | `300000`                    | Wall-clock timeout for a single bash command, ms (raise for slow builds, lower to fail hangs faster)                                                                                                                                                                         |

## Profiles (multi-model)

Define additional model configurations and switch between them at runtime with `/model <name>`:

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

- `/model` — show current profile and list available
- `/model kimi` — switch to the kimi profile (model + endpoint + key swap as a unit)
- `/new` — resets to default

Conversation history persists across switches; if styles clash, run `/new` first. Token counter accumulates across profiles for a single session bill.

## Tools

The agent has these tools. Optional tools register only when their config is present:

| Tool        | What                                                               | Approval?              | Optional?                                              |
| ----------- | ------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------ |
| `read`      | Read lines from a file (line-ranged, default 200 lines)            | no                     | —                                                      |
| `list`      | List files in a directory (depth-limited)                          | no                     | —                                                      |
| `grep`      | JS regex over file contents (cap 100 matches)                      | no                     | —                                                      |
| `glob`      | Find files by path pattern (e.g. `**/*.ts`); no content reading    | no                     | —                                                      |
| `edit`      | Strict find-and-replace; one-occurrence, fails on missing/multiple | yes                    | —                                                      |
| `write`     | Create a new file; refuses to overwrite                            | yes                    | —                                                      |
| `bash`      | Run a shell command (streamed output, danger-pattern warnings)     | yes                    | —                                                      |
| `subagent`  | Spawn an isolated subagent for focused exploration                 | no (its own tools may) | —                                                      |
| `search`    | Web search (returns title + URL + snippet, up to 8)                | no                     | requires `REIKA_SEARXNG_URL` or `REIKA_TAVILY_API_KEY` |
| `fetch_url` | Fetch a URL, extract main content as markdown (defuddle)           | no                     | registered alongside `search`                          |

Approval prompts show a unified diff (or the command for `bash`), with `Approve / Decline / Always (this session)` selectable by `↑↓` + `Enter` or by direct `y`/`n` shortcut.

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

**Rules:**

- Built-in commands always win over skills with the same name — you can't shadow `/help` or `/exit`
- Skill names are lowercased filenames; only `[a-z0-9_-]` are accepted (skip files with weird names)
- Skills load at bootstrap and on `/cd` — edit a file mid-session, then `/cd .` to refresh
- Files under `<cwd>/.reika/` (including `.reika/skills/`, `.reika/handoff/`, etc.) appear in `@` autocomplete — handy for inlining a project-local handoff doc, an in-repo skill file, or any other Reika-scratch content. Other dot-dirs (`.git/`, `.vscode/`, etc.) stay hidden.

## Modes

- **Agent** (default): input goes to the model; it can call tools
- **Shell**: `/shell` to enter — input runs as bash directly (no model, no approval), output streams to scrollback. `/agent` returns.
- **Chat**: `/chat` to enter — pure chat with the model. No filesystem/shell tools registered (only `search` and `fetch_url` if configured). Conversation history is fully isolated from agent mode — switching back and forth keeps each side's history independent. `/agent` returns. Status bar shows a `chat` tag when active.

## Slash commands

Type `/` in the input to see suggestions. Highlights:

| Command                       | What                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `/help`                       | List all commands                                                               |
| `/new` / `/clear`             | Reset conversation, tokens, mode                                                |
| `/cd <path>`                  | Change cwd (re-indexes repo map). Tilde works.                                  |
| `/shell` / `/agent`           | Toggle modes                                                                    |
| `/model` / `/cwd` / `/tokens` | Show current values                                                             |
| `/approvals [on\|off]`        | Show or toggle session auto-approve. `REIKA_AUTO_APPROVE` env var still wins.   |
| `/stats`                      | Full session summary (duration, turns, tools, files modified, approvals)        |
| `/skills`                     | List available skills (loaded from skill dirs at startup)                       |
| `/exit` / `/quit`             | Exit (prints session summary first)                                             |
| `@<path>`                     | In agent mode, inlines a file as context. Tab autocomplete from the file index. |

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

The big design ideas:

- **Bootstrap once.** `bundle.cwd`, `bundle.repoMap`, `bundle.fileIndex`, AGENTS.md, project summary are all built once at startup and kept stable across turns. Critical for prompt caching at the provider.
- **Payload aging.** Tool results carry `summary` + `payload`. Only the latest contiguous block of tool results sends `payload` to the model; older ones collapse to `summary`-only. Keeps history token-bounded without losing information the model just acted on.
- **Single system-prompt builder.** Parameterized; no duplication across modes.
- **OpenAI-compatible end-to-end.** Cloud (OpenAI, OpenRouter, Groq, Moonshot/Kimi) and local (llama.cpp, ollama, LM Studio, vLLM) all work.
- **Streaming, abort, approval, subagent** all flow through one `AbortController` and one set of callbacks.

## Design philosophy

Reika is designed for the world where coding agents — not humans — are often the primary editor. Small models in particular have a fixed token budget per turn, so codebase _shape_ directly affects how well an agent can work in it. The conventions here treat that as a first-class design constraint, not an afterthought:

- **Colocated tests** (`bar.test.ts` next to `bar.ts`) so the model sees both in one directory scan
- **One concept per file, shallow directory depth** so a unit fits in a single read
- **Predictable file shapes within a category** (every tool follows the same `Tool` shape) so the pattern is learned once
- **Names that read like sentences** so identifiers reduce the need for explanatory comments
- **Comments only for WHY, never WHAT** — the model already reads what
- **Light on abstraction** — direct code beats three-layer indirection at small-model scales; "rule of three" becomes more like "rule of five"

Most of these are also just good hygiene for humans. What's different is the cost-benefit math: when the reader is an LLM with a token budget, the case for locality, predictability, and explicit naming gets stronger; the case for clever abstraction gets weaker. See `AGENTS.md` for the longer version and the specific conventions that fall out of this stance.

## Working caveats

- Approval slows multi-edit sessions. Set `REIKA_AUTO_APPROVE=true` for trusted runs. Only "dangerous" commands will force you to manually approve/reject if auto approve is on. So basically yolo mode with safeguards.
- Subagent quality depends entirely on the model; small models often _cost_ turns rather than save them.
- The repo map and file index don't auto-refresh after external file changes — `/cd .` re-indexes.
- Cmd+←/→ on macOS depends on terminal config; Ctrl+A/E always works.

## `.gitignore` is respected

`buildFileIndex`, `buildRepoMap`, `list`, and `grep` all skip paths matched by your project's `.gitignore` (plus `.git/info/exclude`). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply on top — so even projects without a `.gitignore` get sensible exclusions.

## Inspired by

Inspired by Claude Code, Codex, Crush, OpenCode for the Ink-based UI, slash commands, and approval flow, but is tuned for context discipline at the scale of small models rather than cloud models first.
