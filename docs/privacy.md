# Privacy and data

[← README](../README.md)

Reika has no telemetry, no analytics, no crash reporting and no update check. It has no account and
no server of its own. This page lists everything Reika sends over the network and everything it
writes to disk, along with the setting that turns each one off. The source is the final word; this
page is meant to save you reading all of it.

## With no settings changed

- **On by default:**
  - Your model server: the conversation, every turn.
  - The tools that reach the network:
    - `fetch_url` is always available to the model.
    - Pasted links are fetched without asking when the link is the request, and with a question
      otherwise.
    - On macOS with Chrome installed, web search drives a browser.
    - The model's shell commands can reach the network too. They are sandboxed on macOS and not
      elsewhere.
  - The status bar's pull request badge: a `gh` call to GitHub about once a minute, if `gh` is
    installed.
  - Saving every session to disk, unredacted.
- **Off by default:** MCP servers, a separate vision or subagent server, URL grounding, KV-cache
  warming, debug logs and spill stats.

### Keeping everything on your machine

Point Reika at a local server (a `localhost` or private-IP base URL) and add:

```sh
REIKA_PR_BADGE=0              # no gh calls for the status bar
REIKA_CDP_SEARCH=0            # no search browser (and leave REIKA_SEARXNG_URL unset)
REIKA_PASTE_FETCH=off         # pasted links stay text
REIKA_MAX_FETCHES_PER_TURN=0  # every fetch_url call is refused
```

That leaves shell commands. On macOS the sandbox denies their network, except unflagged
`git`/`gh`/`glab`/`hf` commands, which keep it. On Linux and Windows there is no sandbox, so a
command Reika doesn't flag as risky reaches the network freely. Under the default approval mode,
it runs without asking. To be asked before every command, set `REIKA_AUTO_APPROVE=off`.

## What leaves your machine

| Destination                      | Default                   | When                                                                                                                                                                                                                                                                             | What it receives                                                                                                                                                                                                                                                                                    | Turn it off                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model server you configure   | On                        | Every turn. Also a few small requests at startup, on a `/model` switch and before the first turn, to learn the model's context window and how its chat template works. With `REIKA_WARM=1`, a request while you type, carrying the conversation so far (not what you are typing) | The whole conversation: your prompts, a map of your repo's files and symbols, your `AGENTS.md`, files you `@`-mention, text read from pasted images and pages, and everything the model reads or runs: any file it opens and any command's output. With `REIKA_VISION=native`, the images you paste | Use a local server, and the conversation never leaves the machine. The other rows still apply. Switching to another profile with `/model`, or a mode mapped to one with `REIKA_MODE_MODELS`, sends the whole conversation so far to that profile's server |
| Wherever a shell command reaches | On                        | The model runs a command with `bash`                                                                                                                                                                                                                                             | Whatever the command sends                                                                                                                                                                                                                                                                          | See [Keeping everything on your machine](#keeping-everything-on-your-machine): sandboxed on macOS, not elsewhere                                                                                                                                          |
| A subagent server                | Off                       | When the model hands a task to a subagent, only if `REIKA_SUBAGENT_BASE_URL` is set                                                                                                                                                                                              | That subagent's task and what it reads and runs                                                                                                                                                                                                                                                     | Leave it unset, and subagents use your model server                                                                                                                                                                                                       |
| A vision model                   | Off                       | When you paste or drag in an image, only if `REIKA_VISION_MODEL` is set                                                                                                                                                                                                          | The image. It goes to `REIKA_VISION_BASE_URL`, or to your model server when that is unset                                                                                                                                                                                                           | Leave `REIKA_VISION_MODEL` unset. System OCR then reads the image on your machine on macOS and Windows. On Linux there is no system OCR, so the image is not read                                                                                         |
| Web pages                        | On                        | The model calls `fetch_url`, or you paste a link. A pasted link is fetched without asking when the link is the request: a short one-line prompt that starts or ends with it, or asks to read, check or summarize it. Any other pasted link asks first                            | An ordinary GET for that URL                                                                                                                                                                                                                                                                        | `REIKA_PASTE_FETCH=off` for pasted links. `REIKA_MAX_FETCHES_PER_TURN=0` refuses every `fetch_url` call before any request goes out                                                                                                                       |
| A search engine                  | On, on macOS with Chrome  | The model calls `search`                                                                                                                                                                                                                                                         | The query, which the model writes and can include text from your code. On macOS with Chrome installed, it goes to Brave Search in a browser Reika drives, with that browser's cookies. Otherwise it goes to your SearXNG instance, if you set one                                                   | `REIKA_CDP_SEARCH=0`. If you also set no `REIKA_SEARXNG_URL`, `search` isn't registered at all                                                                                                                                                            |
| GitHub, through your `gh`        | On, if `gh` is installed  | While a session is open in a repo, for the status bar's pull request badge: about once a minute while the branch has no PR, every 5 minutes once it has one                                                                                                                      | `gh pr view` for the current repository and branch, under your `gh` login                                                                                                                                                                                                                           | `REIKA_PR_BADGE=0`                                                                                                                                                                                                                                        |
| `models.dev`                     | On, for a hosted endpoint | About once a day, to look up a model's context window and output limit                                                                                                                                                                                                           | A download of the whole public catalog. models.dev sees your IP address and `reika/<version>`. The lookup runs on your machine against the saved copy, so models.dev never learns which provider or model you use                                                                                   | No switch for a hosted endpoint (see below)                                                                                                                                                                                                               |
| Links in code the model writes   | Off                       | Only with `REIKA_URL_GROUNDING=1`                                                                                                                                                                                                                                                | A GET for the URL, to check that it exists                                                                                                                                                                                                                                                          | Leave it off                                                                                                                                                                                                                                              |
| MCP servers you configure        | Off                       | They start with the session. Reika sends them a call when the model uses one of their tools or you type `/<server>:<tool>`                                                                                                                                                       | The call's arguments, which the model writes and can include your code                                                                                                                                                                                                                              | Leave `REIKA_MCP_SERVERS` unset, or set `REIKA_MCP=0`                                                                                                                                                                                                     |

## What the table doesn't show

- **The models.dev lookup has no off switch for a hosted endpoint.** Reika needs the model's output
  limit even when you set `REIKA_CONTEXT_WINDOW`. A server at `localhost`, a `.local` name or a
  private IP address is never looked up. A LAN machine reached by another name (`gpu-box:8080`) is
  treated as hosted.
- **The browsers Reika opens are real browsers, and they make their own requests** to their vendor
  (updates, Safe Browsing and the like), whatever Reika does with them. That is the Chrome web search
  drives, and the Chrome, Edge, Brave or Chromium window `reika web --window` opens. Reika launches
  each on a separate profile, with sync off for search.
- **If your own Chrome is running with remote debugging on port 9222** (or `REIKA_CDP_PORT`), web
  search uses it instead of launching one. Searches then run in your profile, with your logged-in
  cookies, and land in your history.
- **The search profile keeps Brave's cookies on purpose.** A browser that comes back with the same
  profile is served results instead of a bot check. The cost is that Brave can tell your Reika
  searches came from the same browser.
- **MCP servers run as their own processes, and what they do is up to them**, including at startup
  (a server started with `npx` reaches the npm registry on its own). Reika gives them a minimal
  environment plus whatever you put in their config entry, never your API keys.
- **What the sandbox does and doesn't do.** It is macOS only (`REIKA_SANDBOX=0` turns it off).
  - Reika flags some commands as risky: installs, pushes, `curl`, `rm -rf`. A flagged command asks
    you first, and runs unsandboxed once you approve it. Every other command runs sandboxed,
    approved or not.
  - A sandboxed command can write only inside the project, temp and cache directories. Its only
    network is loopback, local sockets such as Docker's, and unflagged `git`/`gh`/`glab`/`hf`
    commands. Those keep the network so `git fetch` and `gh pr view` work, which means the model can
    reach GitHub, GitLab or Hugging Face with your credentials without asking.
  - Two loopback ports are closed even to sandboxed commands: `reika web`'s and the search browser's.
  - It does not restrict reads, so a sandboxed command can read `~/.ssh` like any file you can.
  - See [Tools](tools.md#approvals).
- **A fetch that looks like it is sending data out** asks you first. That is a URL carrying data
  that appeared nowhere in your messages or tool results. It asks even under the default approval
  mode, which otherwise runs ordinary actions without asking. The same check covers `git` and `gh`
  remotes. It does not cover search queries, MCP calls, or a network call made from inside a
  script.
- **A project's `.env` can't redirect any of this.** A `.env` in the project you open is read for
  `REIKA_*` keys only. It is never read for the sandbox, approvals, MCP servers, the web toggles,
  which model a mode uses, the browser Reika runs, the debug and spill-stats file paths, or any URL
  or API key. Those come from your shell or `~/.config/reika/.env` alone, and Reika warns when a
  project `.env` tries to set one. Other settings there do apply, such as turning on debug logs. See
  [Configuration](configuration.md).
- **A repository's content can still steer the model.** Its `AGENTS.md` and skills are loaded, and
  any file the model reads may contain instructions. The approval prompts, the sandbox and the fetch
  check are what stand in the way.
- **`reika web` listens on `127.0.0.1` only.** Nothing off your machine can connect to it, and the
  page loads nothing from other sites.

## What Reika keeps on disk

Everything lives under `~/.config/reika/` unless noted. Reika never uploads these files. Two ways
their contents can still reach your model server: `/resume` sends a saved session back as the
conversation it continues, and the model can read any of them, as it can any file you can.

Turning a setting off stops new writes. It does not delete what is already there.

| Path                                                              | What it holds                                                                                                                                                                                                   | Turn it off                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `history/projects/<project>/*.jsonl`                              | Every session, saved as it runs so `/resume` can reopen it. **Not redacted** (see below)                                                                                                                        | `REIKA_AUTOSAVE=0`, and delete the folder                                          |
| `history/*.jsonl`, `history/*.txt`                                | Transcripts you save with `/save` or `reika -p --save`. Secrets are redacted, unless you pass `/save --raw`                                                                                                     | Don't save one                                                                     |
| `logs/`                                                           | Debug logs, only with `REIKA_DEBUG` set. They quote your task, the commands the model ran, search queries, URLs, compaction notes on what the model found, and server errors. Pruned after 60 days or past 50MB | Leave `REIKA_DEBUG` unset or empty. Any other value turns logging on, `0` included |
| `state.json`                                                      | The mode and model you last picked, so the next launch opens on them                                                                                                                                            | No switch. It is rewritten only when you switch, and you can delete it             |
| `model-limits.json`                                               | The cached `models.dev` catalog                                                                                                                                                                                 | No switch for a hosted endpoint. It is written only for one, and you can delete it |
| `note-slot.json`                                                  | One fact per local model and server about how its chat template renders reasoning, cached for a week                                                                                                            | No switch. Delete it any time                                                      |
| `chrome/`                                                         | The browser profile web search uses: Brave's cookies and the search history                                                                                                                                     | `REIKA_CDP_SEARCH=0`, and delete the folder                                        |
| `window/`                                                         | Browser profiles for `reika web --window`                                                                                                                                                                       | Don't use `--window`, and delete the folder                                        |
| `spill-stats.jsonl`                                               | Sizes of over-long tool results, only with `REIKA_SPILL_STATS=1`. Sizes and tool names, never content                                                                                                           | Leave it unset                                                                     |
| Wherever you point `REIKA_DEBUG_FILE` or `REIKA_SPILL_STATS_FILE` | The same content as `logs/` or `spill-stats.jsonl`, appended across sessions and never pruned                                                                                                                   | Leave them unset                                                                   |
| System temp dir, `reika-<id>/`                                    | Tool output too long to show the model in full, and every page `fetch_url` reads over 2KB, so the model can read the rest from a file. Removed at exit, or at the next launch after a crash                     | `REIKA_SPILL=0`                                                                    |
| System temp dir, `reika-tsc-*.tsbuildinfo`                        | tsc's incremental cache for the post-edit typecheck, one per project, so the next check is fast. Kept across sessions until the OS clears temp                                                                  | `REIKA_TYPECHECK=0`                                                                |
| System temp dir, `reika-window-*/`                                | The sign-in page `reika web --window` opens. Removed once used. A leftover from a run that was killed is removed by the next `--window` launch, once it is an hour old                                          | Don't use `--window`                                                               |
| System temp dir, `reika-clip-*/`                                  | Windows only: a pasted image while it is read. Removed straight after                                                                                                                                           | No switch                                                                          |

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
