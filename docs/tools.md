# Tools

[← README](../README.md)

The agent has these tools. Optional tools register only when their config is present:

| Tool                    | What                                                                    | Approval?                    | Optional?                                                             |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `read`                  | Read lines from a file (line-ranged, default 200 lines)                 | no                           | —                                                                     |
| `list`                  | List files in a directory (depth-limited)                               | no                           | —                                                                     |
| `grep`                  | JS regex over file contents (cap 100 matches)                           | no                           | —                                                                     |
| `glob`                  | Find files by path pattern (e.g. `**/*.ts`); no content reading         | no                           | —                                                                     |
| `edit`                  | Strict find-and-replace; one-occurrence, fails on missing/multiple      | yes                          | —                                                                     |
| `write`                 | Create a new file; refuses to overwrite                                 | yes                          | —                                                                     |
| `bash`                  | Run a shell command (streamed output, danger-pattern warnings)          | yes                          | —                                                                     |
| `subagent`              | Spawn an isolated subagent for focused exploration                      | no (its own tools may)       | —                                                                     |
| `search`                | Web search (returns title + URL + snippet, up to 8)                     | no                           | Chrome on macOS (auto), or `REIKA_CDP_SEARCH=1` / `REIKA_SEARXNG_URL` |
| `fetch_url`             | Fetch a URL, extract main content as markdown (defuddle)                | only a new URL carrying data | always registered while online                                        |
| `mcp__<server>__<tool>` | A tool offered by a configured MCP server (one row per tool; see below) | yes                          | `REIKA_MCP_SERVERS`                                                   |
| `ask_user`              | Ask you ONE multiple-choice question mid-turn and wait for the answer   | no (it _is_ the prompt)      | `REIKA_ASK=0` removes it                                              |

Offline, neither web tool registers: if no interface has a routable address at startup, `search` and `fetch_url` are left out for the session (a scrollback line says so; restart once you're back online). If the network drops mid-session, the first `fetch_url` that finds no route pauses both tools for the rest of that turn rather than letting the model retry against nothing.

The two web tools are registered in **plan** and **grind** mode as well as agent and chat, under the same conditions — a plan or a change sometimes turns on something the repo cannot settle (a library's docs, an API's shape, an issue the request links to), and fetching or searching is a read, so plan mode's "cannot change anything" guarantee is untouched. In grind the alternative is `curl`, which asks on every call under `safe` and has no network under `bypass` or unattended. Minimal mode stays bash-only. Each mode's prompt names them only when they are actually in the list.

`fetch_url` asks before one kind of fetch: a URL that carries data (any query string, or a key- or hash-shaped path segment or host name) and that appears in nothing you or a tool gave the model. That is the shape of a model, steered by text on a page it read, sending something out in the URL. Links from your prompt, search results, fetched pages and files go through without asking, and so do plain URLs like docs pages. The prompt still appears under `REIKA_AUTO_APPROVE=safe`. Under `bypass` the fetch is refused, and in an unattended session it is declined.

`bash` applies the same idea to `git` and `gh`, which keep network access inside the sandbox. A `git clone`, `fetch`, `pull`, `push`, `ls-remote` or `remote add` (or `gh api`) pointed at a host that no link from you or a tool mentioned asks first. The same goes for a known host with data added to the URL. In plan mode that command is refused instead.

Approval prompts show a unified diff (or the command for `bash`), with `Approve / Decline / Always (this session)` selectable by `↑↓` + `Enter` or by direct `y`/`n` shortcut.

`ask_user` renders the same way: `↑↓` + `Enter` to pick an option, `Tab` to pick one _and_ add a note in your own words, or select the last row — always present — to type your own answer instead, when none of the options is the right frame. One question per turn, and the answer is pinned into context afterwards so it can't be forgotten and re-asked later in the same turn. Small models can and do frame a question around a misreading, so the options are not a summary of the request; that last row is the way out.

## MCP servers

With `REIKA_MCP_SERVERS` set, reika starts each configured MCP server as a child process and speaks
MCP's stdio transport to it (JSON-RPC 2.0, newline-framed). Both protocol eras work: reika probes
with `server/discover` and speaks `2026-07-28` to a server that answers it, and falls back to the
`initialize` handshake (`2025-11-25`, accepting any revision back to `2024-11-05`) for one that
does not; `/mcp` shows which each server ended up on. Then `tools/list` and `tools/call`. A server
inherits only `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR` and the locale from
reika's environment — never its API keys — so anything else it needs goes in its entry's `env`.
Every tool a server offers is added to the **agent** tool list as
`mcp__<server>__<tool>` and advertised with the server's own description and JSON Schema, so the
model calls it like any other tool. What comes back is text: image, audio and binary-resource blocks
are replaced by a one-line marker, since this pipeline has no reader for them.

The same tools are exposed as slash commands, `/<server>:<tool>`, so you can call one yourself
without spending a turn — `/gh:search {"q":"reika"}` for a multi-argument tool, or
`/filesystem:read_file src/index.ts` when the tool declares exactly one. The output is printed as a
shell-style block and never enters the conversation. `/mcp` lists the servers, their tools and those
command spellings.

Two things are deliberate. **Agent mode only**: an MCP tool is opaque to the harness — nothing here
can prove a server's tool does not write files — so plan mode (which cannot mutate the repo), chat
(no filesystem or shell) and minimal/grind (a fixed work surface) never get one. **Stdio only**:
remote HTTP/SSE servers are a different trust and auth question and are not supported.

Approval: an MCP call the **model** makes is put through the same gate as everything else, with no
danger warnings attached — reika cannot classify a tool it has never seen. That means `safe` (the
default) runs it, `off` prompts, and `bypass` runs it with nobody to ask. An unattended session
records the decline like any other. The `/<server>:<tool>` command you type yourself is the
exception: it is never gated, the same rule shell mode runs under — nothing prompts you for a
command you just wrote. A server that fails to start, or answers with an error, is reported at
startup and skipped; a call that fails costs one round, not the turn. A server that exits
mid-session keeps its tools in the request's tool list (that list is fixed at session start), so
`/mcp` says so — the calls that follow fail with the exit status rather than silently.

## `.gitignore` is respected

`buildFileIndex`, `buildRepoMap`, `list`, `glob`, and `grep` all skip paths matched by your project's `.gitignore` (plus `.git/info/exclude` and any nested `.gitignore` files, scoped to their own directory as git does). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply on top — so even projects without a `.gitignore` get sensible exclusions.
