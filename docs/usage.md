# Modes, headless and commands

[← README](../README.md)

## Modes

`Shift+Tab` cycles through them, or switch directly with a slash command. The next session opens in
the mode and model you ended the last one in (see
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

Read-only exploration. The model gets only `read`/`list`/`grep`/`glob`, a read-only `bash`, and the
web tools (`fetch_url` when online, plus `search` when a provider is configured). With no `edit` or
`write`, it can't change anything. It explores, then writes a numbered, file-specific plan.

History is **shared** with agent mode, so the flow is: `/plan`, the model writes the plan, then
`/implement` (or `/agent` and a prompt) carries it out with the plan already in context. `/implement`
asks which mode should carry it out: agent (preselected, so Enter alone is enough), minimal or grind.
The session stays in that mode afterwards.

A turn that writes a plan ends with `Plan ready — /implement to execute it, or switch to /agent,
/minimal or /grind and start.` in the scrollback, with the first words tinted so it stands out as the
next step. The line only appears when it's useful: a plan turn that ends in prose without steps
doesn't get one, and neither does vibe's plan phase, which Reika implements on its own.

`REIKA_DEFAULT_MODE=plan` (or the legacy `REIKA_PLAN_EXPERIMENT=1`) starts the session in plan mode.
`/agent` returns.

#### Refining a plan

The plan doesn't have to be right the first time. Another message in plan mode, such as "use the other
approach" or "also cover the settings screen", runs as a _refinement turn_: Reika tells the model that
the plan above is the current one, to keep the steps that still hold, change what the new message asks
for, and rewrite the whole plan.

- A message that only asks about the plan ("why step 3?") is answered without re-emitting it, and the
  plan stays live as written.
- A message that is plainly a different task, leaving the plan above behind, is planned from scratch.
  The model is told to do this only when the message has nothing to do with the plan, so anything
  ambiguous is treated as a revision.
- The rewritten plan is a new plan message, so the checklist, the handoff to agent mode and
  `/implement` all use the newest one. The older plan is replaced, and the handoff summary folds it
  away.
- When a model stalls and Reika has to make it write the plan, that step keeps the previous plan and
  the latest message, so a model that stalls mid-refinement can't quietly rebuild the plan from the
  original request.

Otherwise it works like any plan turn. Exploration stops under the same rules (when rounds stop
turning up anything new, or at the round limit), so a refinement that only needs "check one file,
adjust one step" costs one or two rounds rather than a fresh exploration. If the revised plan comes back
with exactly the steps it had before, a `warn` line in the scrollback says so (unless the message was a
question), so a request that didn't land doesn't pass for a successful revision. Vibe never refines: a
later vibe prompt is a new task, and its plan phase starts fresh.

#### Plan checklist

While a written plan is being implemented, the UI shows its numbered steps as a live checklist. Steps
are checked off from what Reika sees happen, never from the model's own claim of progress. There are
three signals:

- a successful `edit`/`write` to a file the step names;
- a step-quoted code snippet appearing in a successful edit's diff, so a plan that names the wrong file
  still checks off when the model edits the right one (the receipt says so);
- a successful (exit-0) `bash` run containing the step's quoted command, so "run typecheck/tests" steps
  complete.

Progress is worked out from history each turn, so it carries across turns. Steps with none of these
signals are shown but can't be checked off automatically.

**Plan alignment** (on by default; `REIKA_PLAN_ALIGN=0` turns it off) shows the checklist to the model
too. It goes into the system prompt every round of an implementing turn, so the plan can't drop out of
context, and a turn that tries to finish with checkable steps still open is sent back once, with the
unfinished steps quoted. If it finishes anyway, the leftovers are marked waived (`~`): decided once,
and not raised again on later turns.

#### Read-first edits

On by default; `REIKA_READ_FIRST=0` turns it off. When the model edits a file whose contents aren't in
its context (it never read it, through `read` or a one-file `cat`/`sed -n`/`head`, or the read has
since dropped out), the first such `edit` is held back once and the model is told to read the file and
redo the edit from its real contents. Reading first beats working out why an `old_string` didn't match
after the fact. A file is sent back at most once per turn, and the redone edit always runs. An edit
skips the read when its `old_string` is at least 24 characters and matches the file exactly once,
since that text can't be a guess.

#### Read-only bash

On by default; `REIKA_PLAN_BASH=0` removes it. Plan (and vibe) mode gets a `bash` for the kind of
looking around that takes a pipeline, which `read`/`grep`/`glob`/`list` can't do: `grep … | head`,
`find`, `wc -l`. A strict allowlist decides what runs:

- Only listed inspection commands and pipelines of them run, plus a fixed set of GitHub reads
  (`gh issue|pr view/list/diff/checks/status`, `gh repo|run|workflow|release view/list`, `gh search`,
  and `gh api` as a GET that isn't `graphql`), so a plan can be based on the issue or PR it answers.
  A `timeout N` in front of a command is allowed, and the command after it is what gets checked.
- `pr checkout`, clones, downloads, `--web` and `--watch` stay out.
- Redirection, command substitution, `sed`/`awk` and anything unlisted are refused, with the rule and the
  way out stated in the result.

It runs without an approval prompt, since the allowlist has already shown the command can't change
anything, and plan mode's other four tools read any path without asking anyway. The ordinary `bash` in
agent mode prompts as usual. The plan prompt follows the setting, so with `=0` it tells the model
commands are unavailable.

#### Web lookups

Plan (and vibe) mode also gets `search` (when a search provider is configured) and `fetch_url`, so a
plan can draw on things the repo can't answer: a library's docs, an API's shape, an issue the request
links to. Both only read, so plan mode still can't change anything, and `fetch_url` still asks before
opening a URL that carries data, as in agent mode. Offline, neither is available (see
[Tools](tools.md)).

The plan prompt only mentions them when they're available, and the running list of what the model has
examined includes its searches and URLs alongside files and commands, so a model that looked something
up isn't told it has examined nothing. With `REIKA_URL_GROUNDING` on, the check when a plan is written
is a backstop: a URL the plan names without having fetched it still gets verified.

### Vibe

`/vibe` plans and then implements on every prompt. Each prompt first runs as a plan-mode turn
(read-only tools, same stopping rules), and if it ends with a written plan, the plan is carried out
right away as a normal agent turn, with no `/implement` needed. If the plan phase is aborted (ctrl-c)
or ends without a plan, it stops there and nothing else runs.

Approvals work as usual: the implement phase prompts for edits and commands exactly like agent mode,
so `REIKA_AUTO_APPROVE` and `/approvals` are still the only things that change what runs on its own.
It's probably not the mode for the best results; it's there to watch a local model take a task end to
end by itself. `REIKA_DEFAULT_MODE=vibe` starts the session in it.

### Minimal

`/minimal` runs agent turns without the upfront context (no repo map, project summary or `AGENTS.md`
in the system prompt), with `bash` as the only work tool, plus `ask_user`.

### Grind

`/grind` runs agent turns whose prompt is a fixed seven-step procedure instead of the usual agent
rules: pin down what "done" means, look before acting, name two approaches and pick one, make the
smallest change, prove it by running the tests and an edge-case check of its own, review `git diff` and
the callers, and report what was and wasn't verified. These are the steps a strong model takes without
being asked, written down for one that might not.

- It's slower than agent mode (about 3× on the measured fixtures), and it's the one mode that reliably
  reviews its own diff and says what it left unverified. It's meant for harder changes where that care
  is worth the time.
- Tools are `bash`, `read` and `edit`, plus `ask_user` and the web tools under the same conditions as
  agent mode (`fetch_url` when online, `search` with a provider). Project context stays in.
- The loop detectors work as in agent mode. The prompt asks the model to verify by running commands
  rather than by thinking it over again, which keeps it clear of them.
- `REIKA_DEFAULT_MODE=grind` launches in it. Compare modes with
  `pnpm run eval grind-chunk --mode=grind` (and `--mode=agent`, `--mode=minimal`), 3+ runs each.

### Chat

`/chat` is plain conversation with the model. It has no filesystem or shell tools, only `search` and
`fetch_url` if configured. Its history is kept separate from agent mode, so switching back and forth
leaves each side's history as it was.

### Shell

`/shell` runs your input as bash directly, with no model and no approval, and streams the output to the
scrollback.

The model sees what you ran along with your next prompt, from any mode but chat: each command, its
exit status, and the end of its output. That's up to 4KB per run on a large context window and about
1KB on a 16k one, with room for two runs in total, newest first, so an older run may come through as
just its command line. Output that gets cut is saved to a temp file the model can read. `/new` drops
runs that haven't been sent yet.

## Web front end

`reika web` serves the same session to a browser tab on this machine, and `reika web --window` opens
it in an app window. It's experimental; see [Web front end](web.md).

## Headless mode

`reika -p "<prompt>"` runs one turn with no TUI and prints the reply to stdout. It's for scripts,
other harnesses, and letting an agent run Reika itself against a model server. The config and the turn
are the same as in the TUI (the loop, tools, compaction and skills), so a headless run is a faithful
stand-in when debugging.

```sh
reika -p "summarize what this repo does"
echo "explain src/agent/loop.ts" | reika -p          # prompt from stdin
reika -p --mode plan "how would you add X"           # agent (default) | plan | vibe | minimal | grind | chat
reika -p --profile kimi "review this diff"           # run on a named profile
reika -p --json "count the tests" | jq '.[-1].content'   # every message the turn appended
reika -p --stream "explain the build"                # print the reply as it is generated
reika -p --json --stream "..." | jq -c .role         # one message per line (NDJSON) as each lands
reika -p --save "..."                                # write the transcript like /save
reika -p -i "..."                                    # ask approvals and questions on the terminal
reika -p "/verify the input box"                     # run a skill, with the rest as guidance
pnpm run dev -p "..."                                # from a checkout: pnpm forwards -p itself (npm: npm run dev -- -p); banner on stderr
```

- **Approvals** follow `REIKA_AUTO_APPROVE`, with no prompt to fall back on: `bypass` runs everything,
  `safe` (the default) runs ordinary edits and commands and _declines_ anything flagged as dangerous,
  and `off` declines every edit and command (the model is told). Set it explicitly for a run that must
  not write. `ask_user` is never offered.
- **Interactive** (`-i`, `--interactive`): the dialogs the TUI would open are asked on the terminal
  instead of declined. That covers approvals (approve, decline, always for this run, or decline with
  what to do instead), `ask_user` questions (the tool is then offered to the model), and the skill and
  pasted-link confirms. Each is a numbered menu, and Enter takes the marked default, the same row the
  TUI starts on. The menus go to the terminal itself, so stdin can still carry the prompt and stderr
  can go to a log. A run with no terminal (cron, CI) exits with an error instead of waiting for one.
- **stdout is the reply only.** Notices the TUI would put in the scrollback (a fold, a declined
  command, a skill match) go to stderr, and `REIKA_DEBUG=1` still writes the log file.
- **Streaming** (`--stream`): by default nothing prints until the turn ends. With `--stream`, the reply
  text goes to stdout as the model writes it, from every round, so text written before a tool call
  shows too, separated by a blank line. Each tool call's summary goes to stderr
  (`reika: ↳ Read src/a.ts`). Reasoning, a subagent's own rounds and the compaction note stay off
  stdout. With `--json`, each message prints as its own JSON line once it's final: the same objects
  `--json` alone prints as one array at the end. A model with no native tool-call template writes its
  tool calls as text, and that text can show up in the stream; the TUI hides it once the round is done,
  but a pipe can't take it back.
- **Exit status:** 0 on a reply, 1 on an error or a turn that ended without one, 2 when Reika stopped
  the turn itself (a model stuck in a loop, or the round limit), and 130 when interrupted (ctrl-c aborts
  the turn cleanly). A stopped turn prints nothing to stdout. What happened goes to stderr, and `--json`
  marks that message with `harnessStop`.
- **Run summary:** a line on stderr at the end names the model, tokens, time and saved session, the
  same numbers the TUI shows in its status bar.
- **Profiles** (`--profile <name>`): the run uses that profile, ahead of a launch `REIKA_MODEL` and of
  the mode's own model in `REIKA_MODE_MODELS`. Names match case-insensitively. An unknown name prints
  a notice on stderr listing the defined profiles, and the run uses the profile it would have used
  without the flag. A failed turn names the profile and base URL it was on.
- **Auto-save**: a run is saved alongside the TUI's sessions, so `/resume` lists it with them and the
  TUI can pick up where the run left off. `REIKA_AUTOSAVE=0` turns it off. `--save` still writes its
  own `/save`-style transcript as well.
- It's one turn per process, though `--mode vibe` still runs both its plan and implement phases.

### Unattended sessions

For a TUI session left to run on its own (a long turn grinding while you do something else, or
overnight), `REIKA_UNATTENDED=1 reika` gives the TUI the same approval rule as headless: anything that
would prompt is declined, the model is told nobody was there to approve, and `ask_user` isn't offered,
so the turn never stalls on a dialog. The status bar shows `unattended` while it's on.

Back at the keyboard, `/unattended off` puts the prompts back so you can have the model run what it was
declined, and `/unattended on` does the reverse for a session you started attended and are now leaving.
Each turn that declined something ends with a `Declined while unattended` list, built from the declines
themselves, and the model is told to name any judgment call it made alone in its final reply.

How far the model gets on its own depends on the model and the context window. Reika only guarantees
it won't sit waiting for you.

## Slash commands

Type `/` in the input to see suggestions. Highlights:

| Command                                           | What                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help`                                           | List all commands                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/new` / `/clear`                                 | Reset conversation, tokens, mode                                                                                                                                                                                                                                                                                                                                                                                   |
| `/cd <path>`                                      | Change cwd (re-indexes repo map). Tilde works.                                                                                                                                                                                                                                                                                                                                                                     |
| `/shell` / `/chat` / `/plan` / `/vibe` / `/agent` | Switch modes (shell / chat / plan / vibe / back to agent)                                                                                                                                                                                                                                                                                                                                                          |
| `/implement [guidance]`                           | From plan mode: pick agent, minimal or grind (agent preselected), switch to it and execute the plan above (optional guidance)                                                                                                                                                                                                                                                                                      |
| `/compact`                                        | Compact older context now, without a prompt: the model writes a compaction note, then older turns fold into the recap it feeds. Folds number across manual and automatic compaction alike.                                                                                                                                                                                                                         |
| `/model` / `/cwd` / `/tokens`                     | Show current values                                                                                                                                                                                                                                                                                                                                                                                                |
| `/approvals [on\|off]`                            | Show or toggle session auto-approve (bare command opens the on/off/cancel picker). `REIKA_AUTO_APPROVE` env var still wins.                                                                                                                                                                                                                                                                                        |
| `/unattended [on\|off]`                           | Show or toggle unattended (bare command opens the on/off/cancel picker): anything that would prompt is declined and listed at turn end, and questions go unanswered. `REIKA_UNATTENDED=1` sets the starting state.                                                                                                                                                                                                 |
| `/stats`                                          | Full session summary (duration, turns, tools, files modified, approvals)                                                                                                                                                                                                                                                                                                                                           |
| `/save [--raw]`                                   | Save the full conversation to `~/.config/reika/history` (`.jsonl` + `.txt`). Secrets are redacted; `--raw` keeps them verbatim.                                                                                                                                                                                                                                                                                    |
| `/resume [all\|root]`                             | Resume a saved session of this project — each session auto-saves as it runs. In chat mode the list holds only chats, falling back to the `/save` files made in chat mode; `all` lists every session, and every list tags a session holding a chat with `chat`. A session that holds only a chat opens in chat mode, and one with no chat opened from chat mode opens in agent mode. `root` lists the `/save` files |
| `/mcp`                                            | List the MCP servers this session started and every tool they offer, as the `/<server>:<tool>` commands below                                                                                                                                                                                                                                                                                                      |
| `/<server>:<tool> [args]`                         | Call an MCP tool yourself, without a model turn: JSON arguments (`/gh:search {"q":"x"}`), or the bare string when the tool takes exactly one. Output lands as a shell-style block and never enters the conversation                                                                                                                                                                                                |
| `/skills`                                         | List available skills (loaded from skill dirs at startup)                                                                                                                                                                                                                                                                                                                                                          |
| `/search <query>`                                 | Search the web for the query: the model runs one `search` and answers from the results. Needs a provider (`REIKA_SEARXNG_URL` / `REIKA_CDP_SEARCH=1`); without one it says which setting is missing                                                                                                                                                                                                                |
| `/exit` / `/quit`                                 | Exit (prints session summary first)                                                                                                                                                                                                                                                                                                                                                                                |
| `@<path>`                                         | In agent mode, inlines a file as context. Tab autocomplete from the file index.                                                                                                                                                                                                                                                                                                                                    |

## Session transcripts

A saved transcript is titled with the first prompt you typed (`title` on the JSONL meta line,
`# title:` at the top of the `.txt`), so a directory of saves reads as a list of sessions rather than
timestamps. It also records the modes: each turn is labeled with the mode it ran in (`You [plan]:`,
and `mode` on the JSONL record), and the header has the mode at save time plus the whole sequence, as
in `# modes: agent (turns 1-3) → plan (turn 4) → agent (turn 5)`. A vibe turn is recorded as `vibe`,
not as the plan and agent phases it runs internally. So a transcript shows how the work was done, not
just what was said.

`/save` also works while a turn is running. It saves everything up to the last completed round and the
turn carries on, so you can capture a run that looks off and hand the file to another agent without
aborting first. A transcript saved this way is marked (`midTurn` on the JSONL meta line,
`# state: mid-turn` in the `.txt`).

The header also records the status bar's numbers at save time (turn count, session tokens sent and
received, current context against the window, and how much of the last prompt came from cache), so a
shared transcript carries them without a screenshot of the footer:

```
# turns:    7
# tokens:   1.3M↑ 34k↓ (session total, 900k from cache)
# ctx:      45k/128k (35%)
# cache:    89% of the last prompt (40k)
```

Anything that wasn't reported is left out rather than written as zero: a provider that reports no cache
hits gets no cache line at all, and a context size recorded before the first reply arrives is marked
`(estimated)`. The same numbers are in the JSONL meta record under `usage`.
