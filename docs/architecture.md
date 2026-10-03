# Architecture and caveats

[← README](../README.md)

## How a turn is put together

**Bootstrap once.** The repo map, file index, project summary, `AGENTS.md` and cwd are built once at
startup and held stable for the session, which is what lets the engine's prompt-prefix cache survive
turn after turn. `/cd` is the only thing that re-runs bootstrap.

**Repo map.** One line per source file, naming the definitions it exports and ranked so that the files
the rest of the repo reaches for fit inside `REIKA_REPO_MAP_BUDGET` first. It is regex-per-language
rather than a parser, and covers TypeScript/JavaScript (exports), Python, Go, Rust, Java/C#, Kotlin,
Swift, C/C++/Objective-C, Ruby, PHP, Lua and shell.

**Payload aging.** A tool result carries a `summary` and a `payload`. Only the newest contiguous block
of results sends its payload; older ones collapse to their summary, which keeps the history bounded
without losing what the model is acting on right now.

**One system-prompt builder**, parameterized per mode, so no mode's prompt drifts from another's.
**One `AbortController`** carries streaming, abort, approval and subagent. Everything speaks
OpenAI-compatible HTTP, so local engines and hosted APIs take the same path.

## Context and indexing

- **Startup crawls are bounded**, breadth-first: the repo map reads at most 3,000 source files across
  4,000 directories, the file index keeps 10,000 paths, and nested `.gitignore` discovery stops at
  2,000 directories. A tree past those caps — a home directory, a monorepo — starts in about a second
  with a shallow-first map rather than a complete one, so run Reika from the project root for full
  coverage.
- **Nothing re-indexes itself.** `buildFileIndex`, `buildRepoMap`, `list`, `glob` and `grep` skip
  ignored paths (see [Tools](tools.md#gitignore-is-respected)), but a file changed outside Reika stays
  invisible until `/cd .` re-indexes.

## Approvals

Approvals default to `safe`: ordinary edits and commands run on their own, while commands matching a
danger pattern (`rm -rf`, `rm -f`, a force push, `git reset --hard` / `checkout --` / `stash drop`, any
package install or uninstall, `npx`, `curl`/`wget`, `pkill`/`killall`, …) and any write landing outside
the project force a prompt. It is yolo mode with a seatbelt, and everything it lets through is
recoverable from git. `/approvals off` (or `REIKA_AUTO_APPROVE=off`) confirms every action; for truly
no prompts, `REIKA_AUTO_APPROVE=bypass` (or `yolo`) runs dangerous commands without asking.

## Subagents

A subagent buys **context, not speed**: its reads arrive in the parent as one report instead of N
payloads, with the cost that the server re-prefills the parent's context when the subagent returns.
Quality depends on the model, and three rules keep a weak one useful:

- It always returns something — its last budgeted round is a forced report.
- The report ends with a note naming any file the task listed that it never read, so the parent can
  hand the remainder to a second subagent rather than reading it.
- A turn dispatches at most 3 subagent rounds, up to 4 subagents per round. An aged report keeps its
  head (the chain of what it did) rather than collapsing to a byte count like an ordinary payload.

## Terminal

Cmd+←/→ depends on terminal configuration; Ctrl+A/E always works.

## Images

Ctrl-v pastes an image through the OS text recognizer, so it works with any model, text-only included.
It needs `@napi-rs/system-ocr`, which ships prebuilt binaries for macOS and Windows only; on Linux the
paste reports that OCR is unavailable instead of failing. It extracts _text_, so a screenshot of a
stack trace or an error dialog works well and a UI mockup does not.

Two ways to do better than OCR:

- **`REIKA_VISION_MODEL`** routes the image through a vision model, which transcribes the text first
  and then describes what is shown. The description is attached the same way, so the main model still
  never sees pixels and a UI mockup becomes usable. `REIKA_VISION_BASE_URL` and `REIKA_VISION_API_KEY`
  fall back to the main server.
- **`REIKA_VISION=native`** skips the reading step entirely for a model that can see: the pasted bytes
  are sent as an OpenAI multimodal image part, for the turn they were pasted in. It is per-profile too
  (`REIKA_<NAME>_VISION`), so a text-only default can stay on `describe` while `/model <vl>` switches
  one session over and back.

Two things to know about native: the image is sent once, and history keeps a short "not transcribed"
note where the description would go, so the model can ask you to re-paste but cannot look again later.
`@file.png` mentions still go through the reader — only the clipboard path carries bytes — and image
tokens are invisible to the context budget, so each one is charged a fixed allowance when the prompt is
sized.

## Tool calling

Tool calling is most reliable when the model is served with its **native function-calling chat
template**. Without one, models emit tool calls as text, and Reika parses the common dialects as a
best-effort fallback — `<tool_call>{json}</tool_call>`, Hermes `<function=…>`, pythonic `fn(k=v)`, and
calls leaked into the reasoning channel — which exist to catch the malformed, looping and leaked calls
the native path avoids. If a local model misbehaves on tool use, first check that your server
(llama.cpp, Ollama, vLLM, MLX) loads a tools-enabled template for it.
