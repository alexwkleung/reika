# Reika

Minimalistic coding-agent CLI tuned for small local models. Built on TypeScript + Ink, OpenAI-compatible APIs (cloud or llama.cpp), with a focus on context discipline.

## Status

Experimental. Built as a research project exploring how lean a coding agent can be while still being usable on local 3B–9B models — and scaling cleanly to cloud models when you want them.

## Quick start

```sh
npm install
cp .env.example .env
# edit .env to point at your model
npm run dev
```

Example of a local llama.cpp setup with Qwen3.5 (reasoning off for hardware constrained setups):

```sh
llama-server -m /path/to/Qwen3.5-9B-Q5_K_M.gguf \
  --host 127.0.0.1 --port 8080 \
  --jinja --reasoning off
```

## Global install

```sh
npm run install:global     # builds + installs the `reika` binary globally
npm run uninstall:global   # removes it
```

After global install, `reika` is on your `$PATH`. Run it from any project directory.

## Configuration

Config sources, in precedence order (higher wins):

1. **Shell env vars** (e.g. `export REIKA_MODEL=qwen3-9b` in `~/.zshrc`)
2. **Project `.env`** (cwd where you run `reika`) — per-project overrides
3. **Global `~/.config/reika/.env`** — defaults for a global install

`.env` keys (see `.env.example`):

| Key                        | Default                     | What                                                                                  |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `REIKA_BASE_URL`           | `http://localhost:11434/v1` | OpenAI-compatible endpoint                                                            |
| `REIKA_MODEL`              | _required_                  | Model name                                                                            |
| `REIKA_API_KEY`            | `no-key`                    | Cloud API key (any non-empty for local)                                               |
| `REIKA_MAX_TURNS`          | `12`                        | Tool-call iterations per user turn                                                    |
| `REIKA_REPO_MAP_BUDGET`    | `3200`                      | Chars allotted to repo map in system prompt                                           |
| `REIKA_AUTO_APPROVE`       | `false`                     | Skip the approval prompt for edit/write/bash                                          |
| `REIKA_SUBAGENT_MODEL`     | _falls back to main_        | Override model for subagents                                                          |
| `REIKA_SUBAGENT_BASE_URL`  | _falls back_                | Override server for subagents                                                         |
| `REIKA_SUBAGENT_API_KEY`   | _falls back_                | Override key for subagents                                                            |
| `REIKA_SUBAGENT_MAX_TURNS` | `6`                         | Subagent iteration limit                                                              |
| `REIKA_SEARXNG_URL`        | _unset_                     | SearXNG instance URL (self-hosted, local-first). Takes precedence over Tavily         |
| `REIKA_TAVILY_API_KEY`     | _unset_                     | Tavily key — free at [tavily.com](https://tavily.com), enables `search` + `fetch_url` |

## Profiles (multi-model)

Define additional model configurations and switch between them at runtime with `/model <name>`:

```ini
# Default profile (existing keys — always available as "default")
REIKA_MODEL=qwen3-9b
REIKA_BASE_URL=http://localhost:8080/v1
REIKA_API_KEY=no-key

# Additional named profiles — list them, then define each
REIKA_PROFILES=kimi,gpt4
REIKA_KIMI_MODEL=kimi-k2.6
REIKA_KIMI_BASE_URL=https://api.moonshot.ai/v1
REIKA_KIMI_API_KEY=sk-...
REIKA_GPT4_MODEL=gpt-4o
REIKA_GPT4_BASE_URL=https://api.openai.com/v1
REIKA_GPT4_API_KEY=sk-...
```

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
| `edit`      | Strict find-and-replace; one-occurrence, fails on missing/multiple | yes                    | —                                                      |
| `write`     | Create a new file; refuses to overwrite                            | yes                    | —                                                      |
| `bash`      | Run a shell command (streamed output, danger-pattern warnings)     | yes                    | —                                                      |
| `subagent`  | Spawn an isolated subagent for focused exploration                 | no (its own tools may) | —                                                      |
| `search`    | Web search (returns title + URL + snippet, up to 8)                | no                     | requires `REIKA_SEARXNG_URL` or `REIKA_TAVILY_API_KEY` |
| `fetch_url` | Fetch a URL, extract main content as markdown (defuddle)           | no                     | registered alongside `search`                          |

Approval prompts show a unified diff (or the command for `bash`), with `Approve / Decline / Always (this session)` selectable by `↑↓` + `Enter` or by direct `y`/`n` shortcut.

## Modes

- **Agent** (default): input goes to the model; it can call tools
- **Shell**: `/shell` to enter — input runs as bash directly (no model, no approval), output streams to scrollback. `/agent` returns.

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

- Approval slows multi-edit sessions. Set `REIKA_AUTO_APPROVE=true` for trusted runs.
- Subagent quality depends entirely on the model; small models often _cost_ turns rather than save them.
- The repo map and file index don't auto-refresh after external file changes — `/cd .` re-indexes.
- Cmd+←/→ on macOS depends on terminal config; Ctrl+A/E always works.

## `.gitignore` is respected

`buildFileIndex`, `buildRepoMap`, `list`, and `grep` all skip paths matched by your project's `.gitignore` (plus `.git/info/exclude`). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply on top — so even projects without a `.gitignore` get sensible exclusions.

## Inspired by

Claude Code, Codex, Crush, OpenCode — same Ink-based UI shape, similar slash commands and approval flow, but tuned for context discipline at small-model scales rather than cloud-first ergonomics.
