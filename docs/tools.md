# Tools

[← README](../README.md)

The agent has these tools. Optional ones register only when their config is present:

| Tool                    | What                                                                    | Approval?                    | Optional?                                                             |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `read`                  | Read lines from a file (line-ranged, default 200 lines)                 | no                           | —                                                                     |
| `list`                  | List files in a directory (depth-limited)                               | no                           | —                                                                     |
| `grep`                  | JS regex over file contents (cap 100 matches)                           | no                           | —                                                                     |
| `glob`                  | Find files by path pattern (e.g. `**/*.ts`); no content reading         | no                           | —                                                                     |
| `edit`                  | Strict find-and-replace of one exact match; fails if none or several    | yes                          | —                                                                     |
| `write`                 | Create a new file; refuses to overwrite                                 | yes                          | —                                                                     |
| `bash`                  | Run a shell command (streamed output, danger-pattern warnings)          | yes                          | —                                                                     |
| `subagent`              | Spawn an isolated subagent for focused exploration                      | no (its own tools may)       | —                                                                     |
| `search`                | Web search (returns title + URL + snippet, up to 8)                     | no                           | Chrome on macOS (auto), or `REIKA_CDP_SEARCH=1` / `REIKA_SEARXNG_URL` |
| `fetch_url`             | Fetch a URL, extract main content as markdown (defuddle)                | only a new URL carrying data | always registered while online                                        |
| `mcp__<server>__<tool>` | A tool offered by a configured MCP server (one row per tool; see below) | yes                          | `REIKA_MCP_SERVERS`                                                   |
| `ask_user`              | Ask you ONE multiple-choice question mid-turn and wait for the answer   | no (it _is_ the prompt)      | `REIKA_ASK=0` removes it                                              |

`edit` has an experimental positional form, off by default (`REIKA_EDIT_POSITION=1`, see
[configuration](configuration.md)): instead of `old_string` it takes `insert_after` or
`insert_before` (text from the one line to insert beside) or `start_line`/`end_line` written
`N:hash` from `read`'s gutter, which then carries a short hash per line. A range whose hashes no
longer match is refused with the current lines shown, and a range replace returns the lines it
removed.

## Approvals

An approval prompt shows a unified diff (or, for `bash`, the command), with **Approve / Decline /
Always (this session) / Decline, and say what to do instead** selectable by `↑↓` + `Enter` or by the
direct `y`/`n` shortcuts. The last row turns the input box into a field for your reason: `Enter`
sends it, an empty one sends nothing, and `ctrl-c` goes back to the options. The model gets the reason
as a message from you right after the decline, so it has your next instruction rather than a bare
"declined", and it can be a question ("why that file?") as well as a different command. If the
model should stop rather than try something else, say so: "tell me the script" reads to a small model
as run-then-tell, where "don't run anything, just tell me the script" does not.

Two tools ask about more than the obvious:

- **`fetch_url`** asks before one kind of fetch: a URL that carries data (any query string, or a key- or
  hash-shaped path segment or host name) and that appears in nothing you or a tool gave the model. That
  is the shape of a model, steered by text on a page it read, sending something out in the URL. Links
  from your prompt, search results, fetched pages and files go through without asking, and so do plain
  URLs like docs pages. The prompt still appears under `REIKA_AUTO_APPROVE=safe`; under `bypass` the
  fetch is refused, and in an unattended session it is declined.
- **`bash`** applies the same idea to `git` and `gh`. A `git clone`, `fetch`, `pull`, `push`,
  `ls-remote` or `remote add` (or `gh api`) pointed at a host that no link from you or a tool mentioned
  asks first, and so does adding data to a known host's URL. In plan mode that command is refused
  instead.

**`ask_user`** renders the same way: `↑↓` + `Enter` picks an option, and `Tab` picks one _and_ adds a
note in your own words. The last row is always there for typing your own answer when none of the
options fits. The model gets one question per turn, and the answer is pinned into context afterwards so
it isn't forgotten and asked again later in the same turn. Small models can and do frame a question
around a misreading, so the options are not a summary of the request; that last row is the way out.
`Ctrl-C` backs out of the answer field and puts the list back, so an answer started by mistake costs a
keystroke rather than the question; from the list itself it drops the question.

## The web tools

Offline, neither web tool registers: if no interface has a routable address at startup, `search` and
`fetch_url` are left out for the session (a scrollback line says so; restart once you are back online).
If the network drops mid-session, the first `fetch_url` that finds no route pauses both tools for the
rest of that turn rather than letting the model retry against nothing.

They are registered in **plan** and **grind** mode as well as agent and chat, under the same
conditions. A plan or a change sometimes turns on something the repo cannot settle (a library's docs,
an API's shape, an issue the request links to), and fetching or searching is only a read, so plan
mode's "cannot change anything" guarantee still holds. In grind the alternative is `curl`, which asks on every call
under `safe` and has no network under `bypass` or unattended. Minimal mode stays bash-only. Each mode's
prompt mentions them only when they are actually available.

## MCP servers

With `REIKA_MCP_SERVERS` set, Reika starts each configured MCP server as a child process and speaks MCP's
stdio transport to it (JSON-RPC 2.0, newline-framed). Both protocol eras work. Reika probes with
`server/discover` and speaks `2026-07-28` to a server that answers it; for one that does not, it falls
back to the `initialize` handshake (`2025-11-25`, accepting any revision back to `2024-11-05`). `/mcp`
shows which one each server ended up on. After that it uses `tools/list` and `tools/call`.

A server inherits only `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR` and the locale from
Reika's environment, never its API keys, so anything else it needs goes in its entry's `env`.

Every tool a server offers is added to the **agent** tool list as `mcp__<server>__<tool>` and advertised
with the server's own description and JSON Schema, so the model calls it like any other tool. What comes
back is text: image, audio and binary-resource blocks are replaced by a one-line marker, since this
pipeline has no reader for them.

The same tools are exposed as slash commands, `/<server>:<tool>`, so you can call one yourself without
spending a turn: `/gh:search {"q":"reika"}` for a multi-argument tool, or
`/filesystem:read_file src/index.ts` when the tool takes exactly one argument. The output is printed as a
shell-style block and never enters the conversation. `/mcp` lists the servers, their tools and those
command spellings.

Two things are deliberate:

- **Agent mode only.** Reika can't see inside an MCP tool, so it can't prove the tool doesn't write
  files. Plan mode (which must not change the repo), chat (no filesystem or shell) and minimal and grind
  (a fixed set of tools) therefore never get one.
- **Stdio only.** Remote HTTP/SSE servers are a different trust and auth question and are not supported.

**Approval.** An MCP call the **model** makes goes through the same approval gate as everything else,
with no danger warnings attached, since Reika cannot classify a tool it has never seen. That means `safe` (the
default) runs it, `off` prompts, and `bypass` runs it with nobody to ask. An unattended session records
the decline like any other. An MCP server runs outside the sandbox and outside Reika's egress checks, so
for a server whose tools post, push or send data out, add `"approve": "always"` to its entry: every call
from it then prompts even under `safe`, is refused under `bypass`, and is declined when unattended.

```json
{
  "mcpServers": { "slack": { "command": "npx", "args": ["-y", "slack-mcp"], "approve": "always" } }
}
```

The `/<server>:<tool>` command you type yourself is the exception. Like shell mode, it never asks for
approval: nothing prompts you for a command you just wrote.

**Failure.** A server that fails to start, or answers with an error, is reported at startup and skipped;
a call that fails costs one round, not the turn. A server that exits mid-session is started again on
its next call. The call it died during fails and is not retried, since it may already have acted.
After three restarts Reika gives up on it. Its tools stay in the model's tool list, because that list
is fixed at session start, so `/mcp` says the server is gone and later calls fail with its exit status
instead of failing silently. If a restarted server comes back with a different tool list, that is
reported the same way a `list_changed` announcement is, and the session keeps the list it started
with.

**Size and shutdown.** A result over 64K characters reaches the model cut to that size, the same cap
`bash` and `fetch_url` use, with the rest saved to a spill file it can page with `read`. When Reika
exits, each server's stdin is closed and it gets two seconds to exit on its own before it is signaled.

## `.gitignore` is respected

The file index, the repo map, `list`, `glob` and `grep` all skip paths matched by your project's
`.gitignore` (plus `.git/info/exclude` and any nested `.gitignore` files, scoped to their own directory
as git does). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply
on top, so even projects without a `.gitignore` get sensible exclusions.
