# Tools

[← README](../README.md)

The agent has these tools. Optional tools register only when their config is present:

| Tool        | What                                                                  | Approval?                    | Optional?                                                             |
| ----------- | --------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `read`      | Read lines from a file (line-ranged, default 200 lines)               | no                           | —                                                                     |
| `list`      | List files in a directory (depth-limited)                             | no                           | —                                                                     |
| `grep`      | JS regex over file contents (cap 100 matches)                         | no                           | —                                                                     |
| `glob`      | Find files by path pattern (e.g. `**/*.ts`); no content reading       | no                           | —                                                                     |
| `edit`      | Strict find-and-replace; one-occurrence, fails on missing/multiple    | yes                          | —                                                                     |
| `write`     | Create a new file; refuses to overwrite                               | yes                          | —                                                                     |
| `bash`      | Run a shell command (streamed output, danger-pattern warnings)        | yes                          | —                                                                     |
| `subagent`  | Spawn an isolated subagent for focused exploration                    | no (its own tools may)       | —                                                                     |
| `search`    | Web search (returns title + URL + snippet, up to 8)                   | no                           | Chrome on macOS (auto), or `REIKA_CDP_SEARCH=1` / `REIKA_SEARXNG_URL` |
| `fetch_url` | Fetch a URL, extract main content as markdown (defuddle)              | only a new URL carrying data | always registered while online                                        |
| `ask_user`  | Ask you ONE multiple-choice question mid-turn and wait for the answer | no (it _is_ the prompt)      | `REIKA_ASK=0` removes it                                              |

Offline, neither web tool registers: if no interface has a routable address at startup, `search` and `fetch_url` are left out for the session (a scrollback line says so; restart once you're back online). If the network drops mid-session, the first `fetch_url` that finds no route pauses both tools for the rest of that turn rather than letting the model retry against nothing.

`fetch_url` asks before one kind of fetch: a URL that carries data (a long query value, many parameters, or a key- or hash-shaped path segment or host name) and that appears in nothing you or a tool gave the model. That is the shape of a model, steered by text on a page it read, sending something out in the URL. Links from your prompt, search results, fetched pages and files go through without asking, and so do plain URLs like docs pages. The prompt still appears under `REIKA_AUTO_APPROVE=safe`. Under `bypass` the fetch is refused, and in an unattended session it is declined.

Approval prompts show a unified diff (or the command for `bash`), with `Approve / Decline / Always (this session)` selectable by `↑↓` + `Enter` or by direct `y`/`n` shortcut.

`ask_user` renders the same way: `↑↓` + `Enter` to pick an option, `Tab` to pick one _and_ add a note in your own words, or select the last row — always present — to type your own answer instead, when none of the options is the right frame. One question per turn, and the answer is pinned into context afterwards so it can't be forgotten and re-asked later in the same turn. Small models can and do frame a question around a misreading, so the options are not a summary of the request; that last row is the way out.

## `.gitignore` is respected

`buildFileIndex`, `buildRepoMap`, `list`, `glob`, and `grep` all skip paths matched by your project's `.gitignore` (plus `.git/info/exclude` and any nested `.gitignore` files, scoped to their own directory as git does). Hardcoded skip dirs (`node_modules`, `dist`, `build`, `target`, `coverage`, `out`) apply on top — so even projects without a `.gitignore` get sensible exclusions.
