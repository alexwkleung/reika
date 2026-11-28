# Privacy and data

[← README](../README.md)

Reika has no telemetry, no analytics, no crash reporting and no update check. It has no account and
no server of its own. This page lists everything Reika sends over the network and everything it
writes to disk, along with the setting that turns each one off. The source is the final word; this
page is meant to save you reading all of it.

## What leaves your machine

| Destination                    | When                                                                                                                                               | What it receives                                                                                                                                                                            | Turn it off                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The model server you configure | Every turn, plus a few small requests at startup to learn the model's context window and how its chat template works                               | The conversation: your prompts, project context, and the tool results the model asked for                                                                                                   | Use a local server, and it never leaves the machine                                                                                                    |
| A vision model, if you set one | When you paste or drag in an image                                                                                                                 | The image                                                                                                                                                                                   | Leave `REIKA_VISION_MODEL` unset (system OCR runs on the machine)                                                                                      |
| Web pages                      | The model calls `fetch_url`, or you paste a link. A prompt that is just a link is fetched without asking; a link inside a longer prompt asks first | An ordinary GET for that URL                                                                                                                                                                | `REIKA_PASTE_FETCH=off` for pasted links. The model's own `fetch_url` has no switch, apart from minimal mode, which has no web tools                   |
| A search engine                | The model calls `search`                                                                                                                           | The query. On macOS this is Brave Search in a Chrome browser Reika drives; otherwise your SearXNG instance                                                                                  | `REIKA_CDP_SEARCH=0` and no `REIKA_SEARXNG_URL`, and `search` isn't registered at all                                                                  |
| Links in code the model writes | Only with `REIKA_URL_GROUNDING=1` (off by default)                                                                                                 | A GET for the URL, to check that it exists                                                                                                                                                  | Leave it off                                                                                                                                           |
| `models.dev`                   | At most once a day, and only for a hosted endpoint, to look up a model's context window and output limit                                           | A download of the whole public catalog, identified as `reika/<version>`. The lookup runs on your machine against the saved copy, so models.dev never learns which provider or model you use | No switch for a hosted endpoint, since the output limit is looked up even with `REIKA_CONTEXT_WINDOW` set. Local and private hosts are never looked up |
| MCP servers you configure      | When the model calls one of their tools                                                                                                            | The tool call's arguments                                                                                                                                                                   | Leave `REIKA_MCP_SERVERS` unset                                                                                                                        |

A few things that bound the rows above:

- **MCP servers run as their own processes, and what they do is up to them.** Reika gives them only
  a minimal environment, never your API keys.
- **Shell commands the model runs are sandboxed on macOS** and have no network except loopback and
  read-only `git`/`gh`/`glab`/`hf`. A command you approve runs unsandboxed. See
  [Tools](tools.md#approvals).
- **A fetch that looks like it is sending data out** (a URL carrying data that appeared nowhere in
  your messages or tool results) asks you first, even under the default approval mode.
- **A repository can't redirect any of this.** A `.env` in the project you open is read for
  `REIKA_*` keys only, and never for the sandbox, approvals, MCP servers, egress toggles, the debug
  log path, or any URL or API key. Those come from your shell or `~/.config/reika/.env` alone. See
  [Configuration](configuration.md).

## What Reika keeps on disk

Everything lives under `~/.config/reika/` unless noted. Nothing here is uploaded anywhere.

| Path                                                | What it holds                                                                                                                                  | Turn it off                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `history/projects/<project>/*.jsonl`                | Every session, saved as it runs so `/resume` can reopen it. **Not redacted** (see below)                                                       | `REIKA_AUTOSAVE=0`                                           |
| `history/*.jsonl`, `history/*.txt`                  | Transcripts you save with `/save` or `--save`. Secrets are redacted unless you pass `--raw`                                                    | Don't run `/save`                                            |
| `logs/`                                             | Debug logs, only with `REIKA_DEBUG` set. They quote your task and the paths the model touched. Pruned after 60 days or past 50MB               | Leave `REIKA_DEBUG` unset                                    |
| `state.json`                                        | The mode and model you last picked, so the next launch opens on them                                                                           | Delete it; it is rewritten only when you switch              |
| `model-limits.json`                                 | The cached `models.dev` catalog                                                                                                                | Delete it any time; it is written only for a hosted endpoint |
| `note-slot.json`                                    | One fact per local model about how its chat template renders reasoning, cached for a week                                                      | Delete it any time                                           |
| `chrome/`                                           | The browser profile web search uses: cookies and history from Brave Search, kept so engines don't show a bot check every time                  | `REIKA_CDP_SEARCH=0`                                         |
| `window/`                                           | Browser profiles for `reika web --window`                                                                                                      | Don't use `--window`                                         |
| `spill-stats.jsonl`                                 | Sizes of over-long tool results, only with `REIKA_SPILL_STATS=1`. Sizes and tool names, never content                                          | Leave it unset                                               |
| System temp dir, `reika-<id>/`                      | Tool output too long to show the model in full, so it can read the rest from a file. Removed at exit, or at the next launch after a crash      | `REIKA_SPILL=0`                                              |
| System temp dir, `reika-tsc-*.tsbuildinfo`          | tsc's incremental cache for the post-edit typecheck, one per project, so the next check is fast. Kept across sessions until the OS clears temp | `REIKA_TYPECHECK=0`                                          |
| System temp dir, `reika-clip-*/`, `reika-window-*/` | A pasted image while it is read, and the sign-in page `--window` opens. Removed once used, or swept at the next launch                         | Nothing to turn off                                          |

### Why auto-saved sessions aren't redacted

`/resume` rebuilds what the model sees from the saved file. If the file had secrets and paths
replaced, the resumed model would be reading a different conversation from the one it had: it goes
looking for a `~/…` file that was really at an absolute path, or works with a placeholder where a
value used to be. So the auto-save keeps the conversation as it happened, the same as your shell
history or your editor's undo history would.

That makes those files as sensitive as the code and output in them. They are plain files in your
home directory, readable by your user account. If that doesn't suit you, set `REIKA_AUTOSAVE=0`, or
delete the folder for a project. A `/save` transcript, the one meant for sharing, is redacted by
default, and `REIKA_ANON=1` also replaces your git name, email and account names in it.

## If something here doesn't match

If Reika sends a request or writes a file this page doesn't mention, that is a bug in Reika or in
this page, and either way it should be fixed.

- **Found a way around one of the guards** (the sandbox, the approval prompts, the fetch checks)?
  Report it privately, as described in [SECURITY.md](../SECURITY.md).
- **Anything else**: open a [GitHub issue](https://github.com/alexwkleung/reika/issues), or write to
  [hello@reikacode.com](mailto:hello@reikacode.com).
