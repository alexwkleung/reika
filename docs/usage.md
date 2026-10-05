# Modes, headless and commands

[← README](../README.md)

## Modes

`Shift+Tab` cycles through them, or switch directly with a slash command. The mode and model you end a
session in are the ones the next session opens in (see
[Last session state](configuration.md#last-session-state)).

| Mode      | What it does                                                                 | Pick it when                                                                                   |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agent`   | The default: the model reads, edits, and runs commands                       | Most tasks, on any model                                                                       |
| `plan`    | Read-only exploration that ends in a written plan; `/implement` runs it      | You want to agree on the approach before anything changes: unfamiliar code, multi-file changes |
| `vibe`    | Plans first, then implements the plan, on every prompt                       | You want to watch a model take a task end to end on its own; not the mode for best quality     |
| `minimal` | Shell only, with no repo map or project context loaded upfront               | The context window is small and you want as much of it as possible left for the task           |
| `grind`   | Agent turns run a fixed, careful procedure: define done, test, review        | A harder change where checking the work is worth about 3× the time; a larger window helps      |
| `chat`    | Plain conversation with a separate history; web tools only                   | A question that doesn't need the repo                                                          |
| `shell`   | Your input runs as a shell command, and the output joins the agent's context | You want to run something yourself and have the model see the result                           |

Each mode also shows a tag in the status bar while it is active.

### Agent

The default. Your input goes to the model, and the model can call tools.

### Plan

Read-only exploration. Only `read`/`list`/`grep`/`glob`, a read-only `bash`, and the web tools
(`fetch_url` when online, plus `search` when a provider is configured) are registered — no `edit` or
`write` — so the model cannot change anything. It explores and ends by writing a numbered,
file-specific plan.

History is **shared** with agent mode, so the flow is `/plan` → the model writes the plan → `/implement`
(or `/agent` and then a prompt) to execute it with the plan already in context. `/implement` asks which
mode carries the plan out — agent (preselected, so Enter alone keeps the old behavior), minimal or grind
— and the session stays in that mode afterwards.

A turn that commits a plan ends with `Plan ready — /implement to execute it, or switch to /agent,
/minimal or /grind and start.` in the scrollback, its lead tinted in the info color so it reads as the
turn's call to action. Both ways out of plan mode are visible at the moment they are useful, and only
then: a plan turn that dead-ends in prose has no steps and gets no such line, and vibe's plan phase
(which the harness implements itself) gets none either.

`REIKA_DEFAULT_MODE=plan` (or the legacy `REIKA_PLAN_EXPERIMENT=1`) starts the session in plan mode.
`/agent` returns.

#### Refining a plan

The plan does not have to be right the first time. Sending another message in plan mode — "use the other
approach", "also cover the settings screen" — runs as a _refinement turn_: the harness notes that the
plan above is the live one and tells the model to keep the steps that still hold, change what the new
message asks for, and rewrite the whole plan.

- A message that only asks about the plan ("why step 3?") is answered without re-emitting it, and the
  plan stays live as written.
- A message that is plainly a different task — the plan above abandoned — is planned from scratch. The
  model is told to take that way out only when the message has nothing to do with the plan, so anything
  ambiguous is treated as a revision.
- The rewritten plan is a fresh plan message, so the checklist, the plan→agent handoff and `/implement`
  all anchor on the newest one; the older plan is superseded (the handoff digest folds it away).
- The force-write recovery carries the previous plan and the latest message through its transform, so a
  model that stalls mid-refinement cannot silently rebuild the plan from the original request.

It is the same convergence machinery otherwise — exploration stops after the same novelty and ceiling
rules, so a refinement that is only "check one file, adjust one step" costs one or two rounds rather than
a re-exploration. If the revised plan comes back with exactly the steps it had before, a `warn` line in
the scrollback says so (unless the message was a question), so a request that didn't land is visible
instead of looking like a successful revision. Vibe never refines: a later vibe prompt is a new task
whose plan phase starts fresh.

#### Plan checklist

While a written plan is being implemented, the UI shows its numbered steps as a live checklist and
checks steps off from harness-observed facts — never the model's own claim of progress. Three
deterministic signals:

- a successful `edit`/`write` to a file the step names;
- a step-quoted code snippet appearing in a successful edit's diff, so a plan that names the wrong file
  still checks off when the model edits the right one (the receipt says so);
- a successful (exit-0) `bash` run containing the step's quoted command, so "run typecheck/tests" steps
  complete.

Progress is recomputed from history each turn, so it survives across turns. Steps with none of these
signals display but cannot auto-check.

**Plan alignment** (on by default; `REIKA_PLAN_ALIGN=0` turns it off) adds model-facing pressure on top
of the tracking: the checklist rides the system prompt every round of an implementing turn, so the plan
cannot age out of context, and a turn that tries to finish with observable steps unchecked is sent back
once with the unfinished steps quoted. If it finishes anyway, the leftovers are marked waived (`~`) —
adjudicated once, never re-asked on later turns.

#### Read-first edits

On by default; `REIKA_READ_FIRST=0` turns it off. The first `edit` to a file whose contents are not in
the model's context — never read, or the read has aged out — is withheld once, with a directive to read
the file and re-issue the edit from its actual bytes: reading first, instead of reasoning about an
`old_string` failure after the fact. One bounce per file per turn, and a re-issued edit always runs.

#### Read-only bash

On by default; `REIKA_PLAN_BASH=0` removes it. It is registered in plan (and vibe) mode for the
inspection a pipeline expresses that `read`/`grep`/`glob`/`list` cannot — `grep … | head`, `find`,
`wc -l`. A strict allowlist classifier decides:

- Only listed inspection commands and pipelines of them run, plus a fixed set of GitHub reads
  (`gh issue|pr view/list/diff/checks/status`, `gh repo|run|workflow|release view/list`, `gh search`,
  and `gh api` as a GET that isn't `graphql`) — so a plan can be grounded in the issue or PR it answers.
  A `timeout N` carrier in front of one is read through to the command it bounds.
- `pr checkout`, clones, downloads, `--web` and `--watch` stay out.
- Redirection, command substitution, `sed`/`awk` and anything unlisted are refused, with the rule and the
  way out stated in the result.

It runs without an approval prompt: the classifier has proved the command cannot mutate anything, and
plan mode's other four tools already read arbitrary paths silently. The ordinary `bash` in agent mode
prompts exactly as before. The plan system prompt tracks the flag, so under `=0` it goes back to saying
commands are unavailable.

#### Web lookups

`search` (when a search provider is configured) and `fetch_url` are registered in plan (and vibe) mode
too, so a plan can be grounded in something the repo cannot settle: a library's docs, an API's shape, an
issue the request links to. They are reads, so the mode's guarantee is unchanged, and `fetch_url`'s
data-carrying-URL prompt works there exactly as in agent mode. Offline, neither registers (see
[Tools](tools.md)).

The plan prompt names them only when they are present, and the exploration ledger lists the queries and
URLs the same way it lists files and commands — for the same reason it had to list `bash` pipelines. It
also means `REIKA_URL_GROUNDING`'s plan-commit check is a backstop: a URL the plan wrote without
fetching still gets verified.

### Vibe

`/vibe` enters the full plan→implement pipeline on every prompt. Each prompt first runs as a plan-mode
turn (read-only tools, same convergence machinery), and if it ends with a written plan, the plan is
implemented immediately as a normal agent turn — no `/implement` needed. A plan phase that is aborted
(ctrl-c) or dead-ends without a plan stops there; nothing chains.

Approvals are untouched: the implement phase prompts for edits and commands exactly like agent mode, so
`REIKA_AUTO_APPROVE` / `/approvals` remain the only things that change what auto-runs. Probably not the
mode for maximum quality — it exists to watch a local model go end-to-end on its own.
`REIKA_DEFAULT_MODE=vibe` starts the session in it.

### Minimal

`/minimal` enters an agent turn with none of the upfront context — no repo map, project summary, or
`AGENTS.md` in the system prompt — and `bash` as its only work tool, plus `ask_user`.

### Grind

`/grind` enters an agent turn whose prompt is a fixed seven-step procedure in place of the agent rules:
pin down what "done" means, look before acting, name two approaches and pick one, make the smallest
change, prove it by running the tests and an edge-case check of its own, review `git diff` and the
callers, and report what was and was not verified. The steps a strong model takes unprompted, written
down for one that may not.

- Slower than agent mode — about 3× on the measured fixtures — and the one mode that reliably reviews its
  own diff and says what it left unverified. Meant for harder changes where that care is worth the time.
- Tools are `bash`, `read` and `edit`, plus `ask_user` and the web tools under the same conditions as
  agent mode (`fetch_url` when online, `search` with a provider). Project context stays in.
- The loop detectors are unchanged. The prompt asks for verification by running commands rather than by
  re-thinking, which is what keeps it clear of them.
- `REIKA_DEFAULT_MODE=grind` launches in it. Compare modes with
  `pnpm run eval grind-chunk --mode=grind` (and `--mode=agent`, `--mode=minimal`), 3+ runs each.

### Chat

`/chat` enters pure chat with the model: no filesystem or shell tools are registered, only `search` and
`fetch_url` if configured. Conversation history is fully isolated from agent mode, so switching back and
forth keeps each side's history independent.

### Shell

`/shell` runs your input as bash directly — no model, no approval — and streams the output to the
scrollback.

## Headless mode

`reika -p "<prompt>"` runs one turn with no TUI and prints the reply to stdout — for scripts, other
harnesses, and letting an agent run Reika itself against a model server. Same config, same turn: the
loop, tools, compaction and skills are the ones the TUI runs, so a headless run is a faithful stand-in
when debugging.

```sh
reika -p "summarize what this repo does"
echo "explain src/agent/loop.ts" | reika -p          # prompt from stdin
reika -p --mode plan "how would you add X"           # agent (default) | plan | vibe | minimal | grind | chat
reika -p --json "count the tests" | jq '.[-1].content'   # every message the turn appended
reika -p --stream "explain the build"                # print the reply as it is generated
reika -p --json --stream "..." | jq -c .role         # one message per line (NDJSON) as each lands
reika -p --save "..."                                # write the transcript like /save
reika -p "/verify the input box"                     # run a skill, with the rest as guidance
pnpm run dev -p "..."                                # from a checkout: pnpm forwards -p itself (npm: npm run dev -- -p); banner on stderr
```

- **Approvals** follow `REIKA_AUTO_APPROVE` with no prompt to fall back on: `bypass` runs everything,
  `safe` (the default) runs ordinary edits and commands and _declines_ anything the danger scan flags,
  and `off` declines every edit and command (the model is told). Set it explicitly for a run that must
  not write. `ask_user` is never offered.
- **stdout is the reply only.** Notices the TUI would put in the scrollback — a fold, a declined command,
  a skill match — go to stderr, and `REIKA_DEBUG=1` still writes the log file.
- **Streaming** (`--stream`): by default nothing prints until the turn ends. With `--stream` the reply
  text goes to stdout as the model generates it — every round's, so the text written before a tool call
  shows too, separated by a blank line — and each tool call's summary goes to stderr
  (`reika: ↳ Read src/a.ts`). Reasoning, a subagent's own rounds and the compaction note stay off stdout.
  With `--json` it prints each message as its own JSON line when it is committed, the same objects
  `--json` alone prints as one array at the end. Text streamed from a model with no native tool-call
  template can include its in-band call text, which the TUI hides once the round lands but a pipe cannot
  take back.
- **Exit status:** 0 on a reply, 1 on an error or a turn that ended without one, 130 when interrupted
  (ctrl-c aborts the turn cleanly).
- One turn per process; `--mode vibe` still chains plan → implement inside it.

### Unattended sessions

For a TUI session left to run on its own — a long turn grinding while you do something else, or
overnight — `REIKA_UNATTENDED=1 reika` gives the TUI the same approval rule as headless: whatever would
prompt is declined, the model is told nobody was there to approve, and `ask_user` isn't offered, so the
turn never stalls on a dialog. The status bar shows `unattended` while it is on.

Back at the keyboard, `/unattended off` puts the prompts back so you can have the model run what it was
declined, and `/unattended on` does the reverse for a session you started attended and are now leaving.
Each turn that declined something ends with a `Declined while unattended` list, built from the declines
themselves, and the model is told to name any judgment call it made alone in its final reply.

How far the model gets on its own depends on the model and the context window; the harness only
guarantees it won't wait on you.

## Slash commands

Type `/` in the input to see suggestions. Highlights:

| Command                                           | What                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                                           | List all commands                                                                                                                                                                                                   |
| `/new` / `/clear`                                 | Reset conversation, tokens, mode                                                                                                                                                                                    |
| `/cd <path>`                                      | Change cwd (re-indexes repo map). Tilde works.                                                                                                                                                                      |
| `/shell` / `/chat` / `/plan` / `/vibe` / `/agent` | Switch modes (shell / chat / plan / vibe / back to agent)                                                                                                                                                           |
| `/implement [guidance]`                           | From plan mode: pick agent, minimal or grind (agent preselected), switch to it and execute the plan above (optional guidance)                                                                                       |
| `/compact`                                        | Compact older context now, without a prompt: the model writes a compaction note, then older turns fold into the recap it feeds. Folds number across manual and automatic compaction alike.                          |
| `/model` / `/cwd` / `/tokens`                     | Show current values                                                                                                                                                                                                 |
| `/approvals [on\|off]`                            | Show or toggle session auto-approve (bare command opens the on/off/cancel picker). `REIKA_AUTO_APPROVE` env var still wins.                                                                                         |
| `/unattended [on\|off]`                           | Show or toggle unattended (bare command opens the on/off/cancel picker): anything that would prompt is declined and listed at turn end, and questions go unanswered. `REIKA_UNATTENDED=1` sets the starting state.  |
| `/stats`                                          | Full session summary (duration, turns, tools, files modified, approvals)                                                                                                                                            |
| `/save [--raw]`                                   | Save the full conversation to `~/.config/reika/history` (`.jsonl` + `.txt`). Secrets are redacted; `--raw` keeps them verbatim.                                                                                     |
| `/mcp`                                            | List the MCP servers this session started and every tool they offer, as the `/<server>:<tool>` commands below                                                                                                       |
| `/<server>:<tool> [args]`                         | Call an MCP tool yourself, without a model turn: JSON arguments (`/gh:search {"q":"x"}`), or the bare string when the tool takes exactly one. Output lands as a shell-style block and never enters the conversation |
| `/skills`                                         | List available skills (loaded from skill dirs at startup)                                                                                                                                                           |
| `/exit` / `/quit`                                 | Exit (prints session summary first)                                                                                                                                                                                 |
| `@<path>`                                         | In agent mode, inlines a file as context. Tab autocomplete from the file index.                                                                                                                                     |

## Session transcripts

A saved transcript is titled by the first prompt you typed (`title` on the JSONL meta line, `# title:`
atop the `.txt`), so a directory of saves reads as a list of sessions rather than timestamps. It also
records the mode alongside the conversation: each turn is labeled with the mode it ran in
(`You [plan]:`, and `mode` on the JSONL record), and the header carries the mode at save time plus the
whole arc — `# modes: agent (turns 1-3) → plan (turn 4) → agent (turn 5)`. A vibe turn is recorded as
`vibe`, not as the plan and agent phases it runs as internally. So a transcript says how the work was
done, not just what was said.

`/save` also works while a turn is running: it snapshots everything up to the last completed round and
the turn carries on, so you can capture a run that looks off and hand the file to another agent without
aborting first. Such a transcript is marked (`midTurn` on the JSONL meta line, `# state: mid-turn` in
the `.txt`).

The header also freezes the status line's accounting at save time — turn count, session tokens sent and
received, current context against the window, and how much of the last prompt came from cache — so a
shared transcript carries the numbers without the footer pasted beside it:

```
# turns:    7
# tokens:   1.3M↑ 34k↓ (session total, 900k from cache)
# ctx:      45k/128k (35%)
# cache:    89% of the last prompt (40k)
```

Anything unreported is left out rather than written as zero: a provider that reports no cache hits gets
no cache line at all, and a context size recorded before the first call lands is marked `(estimated)`.
The same numbers ride the JSONL meta record under `usage`.
