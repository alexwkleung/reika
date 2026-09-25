# Modes, headless and commands

[← README](../README.md)

## Modes

`Shift+Tab` cycles through them (agent → plan → minimal → vibe → chat → shell), or switch directly with the slash commands below. The mode you end a session in is the one the next session opens in (see [Last session state](configuration.md#last-session-state)).

- **Agent** (default): input goes to the model; it can call tools
- **Minimal**: `/minimal` to enter — an agent turn with none of the upfront context (no repo map, project summary, or AGENTS.md in the system prompt) and `bash` as its only work tool, plus `ask_user`. `/agent` returns.
- **Shell**: `/shell` to enter — input runs as bash directly (no model, no approval), output streams to scrollback. `/agent` returns.
- **Chat**: `/chat` to enter — pure chat with the model. No filesystem/shell tools registered (only `search` and `fetch_url` if configured). Conversation history is fully isolated from agent mode — switching back and forth keeps each side's history independent. `/agent` returns. Status bar shows a `chat` tag when active.
- **Plan**: `/plan` to enter — read-only exploration. Only `read`/`list`/`grep`/`glob` and a read-only `bash` are registered (no `edit`/`write`), so the model can't change anything; it explores and ends by writing a numbered, file-specific plan. Unlike chat, history is **shared** with agent mode, so the flow is `/plan` → it writes the plan → `/implement` (or `/agent` then a prompt) to execute it with the plan already in context. `REIKA_DEFAULT_MODE=plan` (or the legacy `REIKA_PLAN_EXPERIMENT=1`) starts the session in plan mode. `/agent` returns. Status bar shows a `plan` tag when active.
  - **Plan checklist**: while a written plan is being implemented, the UI shows its numbered steps as a live checklist and checks steps off from harness-observed facts — never the model's own claim of progress. Three deterministic signals: a successful `edit`/`write` to a file the step names; a step-quoted code snippet appearing in a successful edit's diff (so a plan that names the wrong file still checks off when the model edits the right one — the receipt says so); and a successful (exit-0) `bash` run containing the step's quoted command (so "run typecheck/tests" steps complete). Progress is recomputed from history each turn, so it survives across turns. Steps with none of these signals display but can't auto-check.
  - `REIKA_PLAN_ALIGN=1` (experimental) adds model-facing pressure on top of the tracking: the checklist rides the system prompt every round of an implementing turn (so the plan can't age out of context), and a turn that tries to finish with observable steps unchecked is sent back once with the unfinished steps quoted. If it finishes anyway, the leftovers are marked waived (`~`) — adjudicated once, never re-asked on later turns.
  - **Read-first edits** (on by default; `REIKA_READ_FIRST=0` turns it off) prevent blind edits: the first `edit` to a file whose contents are not in the model's context — never read, or the read has aged out — is withheld once, with a directive to read the file and re-issue the edit from its actual bytes, reading first instead of reasoning about an `old_string` failure after the fact. One bounce per file per turn; a re-issued edit always runs.
  - **Read-only `bash`** (on by default; `REIKA_PLAN_BASH=0` removes it) is registered in plan (and vibe) mode, for the inspection a pipeline expresses that `read`/`grep`/`glob`/`list` cannot — `grep … | head`, `find`, `wc -l`. A strict allowlist classifier (`tools/_readonly.ts`) decides: only listed inspection commands and pipelines of them run, and redirection, command substitution, `sed`/`awk` and anything unlisted are refused with the rule and the way out stated in the result. It runs without an approval prompt — the classifier has proved the command cannot mutate anything, and plan mode's other four tools already read arbitrary paths silently — while the ordinary `bash` in agent mode prompts exactly as before. The plan system prompt tracks the flag, so under `=0` it goes back to saying commands are unavailable.
- **Vibe**: `/vibe` to enter — the full plan→implement pipeline on every prompt. Each prompt first runs as a plan-mode turn (read-only tools, same convergence machinery), and if it ends with a written plan, the plan is implemented immediately as a normal agent turn — no `/implement` needed. A plan phase that is aborted (ctrl-c) or dead-ends without a plan stops there; nothing chains. Approvals are untouched: the implement phase prompts for edits and commands exactly like agent mode, so `REIKA_AUTO_APPROVE` / `/approvals` remain the only things that change what auto-runs. Probably not the mode for maximum quality — it exists to watch a local model go end-to-end on its own. `REIKA_DEFAULT_MODE=vibe` starts the session in vibe mode. `/agent` returns. Status bar shows a `vibe` tag when active.

## Headless mode

`reika -p "<prompt>"` runs one turn with no TUI and prints the reply to stdout (#52) — for scripts, other harnesses, and letting an agent run reika itself against a model server. Same config, same turn: the loop, tools, compaction, and skills are the ones the TUI runs, so a headless run is a faithful stand-in when debugging.

```sh
reika -p "summarize what this repo does"
echo "explain src/agent/loop.ts" | reika -p          # prompt from stdin
reika -p --mode plan "how would you add X"           # agent (default) | plan | vibe | minimal | chat
reika -p --json "count the tests" | jq '.[-1].content'   # every message the turn appended
reika -p --save "..."                                # write the transcript like /save
reika -p "/verify the input box"                     # run a skill, with the rest as guidance
npm run -s dev -- -p "..."                           # from a checkout: -- so npm doesn't eat -p, -s to keep its banner off stdout
```

- **Approvals** follow `REIKA_AUTO_APPROVE` with no prompt to fall back on: `bypass` runs everything, `safe` (the default) runs ordinary edits/commands and _declines_ anything the danger scan flags, `off` declines every edit and command (the model is told) — set it explicitly for a run that must not write. `ask_user` is never offered.
- **stdout is the reply only** — notices the TUI would put in the scrollback (a fold, a declined command, a skill match) go to stderr, and `REIKA_DEBUG=1` still writes the log file.
- **Exit status**: 0 on a reply, 1 on an error or a turn that ended without one, 130 when interrupted (ctrl-c aborts the turn cleanly).
- One turn per process; `--mode vibe` still chains plan → implement inside it.

For a TUI session left to run on its own — a long turn grinding while you do something else, or overnight — `REIKA_UNATTENDED=1 reika` gives the TUI the same approval rule: whatever would prompt is declined, the model is told nobody was there to approve, and `ask_user` isn't offered, so the turn never stalls on a dialog. The status bar shows `unattended` while it's on. How far the model gets on its own depends on the model and the context window; the harness only guarantees it won't wait on you.

## Slash commands

Type `/` in the input to see suggestions. Highlights:

| Command                                           | What                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help`                                           | List all commands                                                                                                                                                                          |
| `/new` / `/clear`                                 | Reset conversation, tokens, mode                                                                                                                                                           |
| `/cd <path>`                                      | Change cwd (re-indexes repo map). Tilde works.                                                                                                                                             |
| `/shell` / `/chat` / `/plan` / `/vibe` / `/agent` | Switch modes (shell / chat / plan / vibe / back to agent)                                                                                                                                  |
| `/implement [guidance]`                           | From plan mode: switch to agent and execute the plan above (optional guidance)                                                                                                             |
| `/compact`                                        | Compact older context now, without a prompt: the model writes a compaction note, then older turns fold into the recap it feeds. Folds number across manual and automatic compaction alike. |
| `/model` / `/cwd` / `/tokens`                     | Show current values                                                                                                                                                                        |
| `/approvals [on\|off]`                            | Show or toggle session auto-approve. `REIKA_AUTO_APPROVE` env var still wins.                                                                                                              |
| `/stats`                                          | Full session summary (duration, turns, tools, files modified, approvals)                                                                                                                   |
| `/save [--raw]`                                   | Save the full conversation to `~/.config/reika/history` (`.jsonl` + `.txt`). Secrets are redacted; `--raw` keeps them verbatim.                                                            |
| `/skills`                                         | List available skills (loaded from skill dirs at startup)                                                                                                                                  |
| `/exit` / `/quit`                                 | Exit (prints session summary first)                                                                                                                                                        |
| `@<path>`                                         | In agent mode, inlines a file as context. Tab autocomplete from the file index.                                                                                                            |

A saved transcript is titled by the first prompt you typed (`title` on the JSONL meta line, `# title:` atop the `.txt`), so a directory of saves reads as a list of sessions rather than timestamps. It also records mode alongside the conversation: each turn is labelled with the mode it ran in (`You [plan]:`, and `mode` on the JSONL record), and the header carries the mode at save time plus the whole arc — `# modes: agent (turns 1-3) → plan (turn 4) → agent (turn 5)`. A vibe turn is recorded as `vibe`, not as the plan and agent phases it runs as internally. So a transcript says how the work was done, not just what was said.

`/save` also works while a turn is running: it snapshots everything up to the last completed round and the turn carries on, so you can capture a run that looks off and hand the file to another agent without aborting first. Such a transcript is marked (`midTurn` on the JSONL meta line, `# state: mid-turn` in the `.txt`).

The header also freezes the status line's accounting at save time — turn count, session tokens sent and received, current context against the window, and how much of the last prompt came from cache — so a shared transcript carries the numbers without the footer pasted beside it:

```
# turns:    7
# tokens:   1.3M↑ 34k↓ (session total, 900k from cache)
# ctx:      45k/128k (35%)
# cache:    89% of the last prompt (40k)
```

Anything unreported is left out rather than written as zero: a provider that reports no cache hits gets no cache line at all, and a context size recorded before the first call lands is marked `(estimated)`. The same numbers ride the JSONL meta record under `usage`.
